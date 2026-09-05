/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as fs from 'node:fs';
import {PassThrough} from 'node:stream';
import {text} from 'node:stream/consumers';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

/** Decoded output of a single command executed inside the container. */
export interface ExecOutput {
  /** What the command wrote to standard output. */
  stdout: string;
  /** What the command wrote to standard error. */
  stderr: string;
  /** The status the command exited with, or null when Docker reported none. */
  exitCode: number | null;
}

/**
 * Containers that must be cleaned up when the process exits. One set with one
 * set of process hooks avoids leaking a listener per container instance.
 */
const activeContainers = new Set<Docker.Container>();
let exitHooksRegistered = false;

/** Best-effort cleanup of every tracked container on process exit. */
async function cleanupContainers(): Promise<void> {
  for (const container of activeContainers) {
    try {
      await container.stop();
      await container.remove();
      activeContainers.delete(container);
    } catch (error: unknown) {
      logger.error(`Failed to stop and remove container on exit: ${error}`);
    }
  }
}

/** The termination signals the cleanup hook runs on. */
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type ExitSignal = (typeof EXIT_SIGNALS)[number];

/**
 * Cleans up on a termination signal, then re-raises it.
 *
 * Node drops its own terminate-on-signal behaviour as soon as any listener
 * exists, so a handler that only cleans up would make the whole host process
 * ignore its first `SIGINT` or `SIGTERM`. The listener is registered with
 * `once`, so it is already detached here and the second delivery reaches
 * whatever else the application registered, or Node's default.
 */
async function handleExitSignal(signal: ExitSignal): Promise<void> {
  await cleanupContainers();
  process.kill(process.pid, signal);
}

/**
 * Registers process-exit hooks once. Node cannot run asynchronous Docker
 * cleanup on the synchronous `'exit'` event, so `'beforeExit'` and the
 * termination signals are used instead. This is the parity substitute for
 * Python's `weakref.finalize`, which has no safe Node equivalent.
 */
function registerExitHooks(): void {
  if (exitHooksRegistered) {
    return;
  }
  exitHooksRegistered = true;
  process.once('beforeExit', cleanupContainers);
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, handleExitSignal);
  }
}

/** Docker daemon url schemes that dockerode names differently. */
const PROTOCOL_BY_SCHEME: Record<string, 'https' | 'http' | 'ssh'> = {
  'https:': 'https',
  'ssh:': 'ssh',
};

/** Maps a Docker daemon base url to dockerode client options. */
function parseBaseUrl(baseUrl: string): Docker.DockerOptions {
  const url = new URL(baseUrl);
  if (url.protocol === 'unix:') {
    return {socketPath: url.pathname};
  }
  return {
    host: url.hostname,
    port: url.port || undefined,
    protocol: PROTOCOL_BY_SCHEME[url.protocol] ?? 'http',
  };
}

/** Options for {@link DockerContainer}. */
export interface DockerContainerOptions {
  /** Tag of the predefined or custom image to run on the container. */
  image: string;
  /**
   * Start the container with networking enabled. When false, the container
   * cannot reach the network, which is the safe default for untrusted code.
   */
  networkEnabled: boolean;
  /** Base url of a user-hosted Docker daemon. */
  baseUrl?: string;
  /**
   * Injected Docker client. When omitted, dockerode is loaded lazily and a
   * client is built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * The Docker container backing a code executor. It owns the whole lifecycle
 * (`build` then `start` then `execute` then `stop`) and the Docker client
 * resolution, so callers decide what to run and not how to drive Docker.
 */
export class DockerContainer {
  private clientPromise?: Promise<Docker>;
  private container?: Docker.Container;

  constructor(private readonly options: DockerContainerOptions) {}

  /** Builds the image from a directory that holds a Dockerfile. */
  async build(dockerPath: string): Promise<void> {
    if (!fs.existsSync(dockerPath)) {
      throw new Error(`Invalid Docker path: ${dockerPath}`);
    }
    const client = await this.getClient();
    logger.debug(`Building Docker image ${this.options.image}...`);
    const stream = await client.buildImage(
      {context: dockerPath, src: fs.readdirSync(dockerPath)},
      {t: this.options.image},
    );
    await new Promise<void>((resolve, reject) => {
      client.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    logger.debug(`Docker image ${this.options.image} built.`);
  }

  /**
   * Creates and starts the container, and registers it for cleanup on process
   * exit. Throws when it is already started, because overwriting the handle
   * would orphan the running container. Call {@link stop} first.
   */
  async start(): Promise<void> {
    if (this.container) {
      throw new Error('Container is already started.');
    }
    const client = await this.getClient();
    logger.debug(`Starting container from ${this.options.image}...`);
    const container = await client.createContainer({
      Image: this.options.image,
      Tty: true,
      NetworkDisabled: !this.options.networkEnabled,
      HostConfig: {CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges']},
    });
    await container.start();
    this.container = container;
    activeContainers.add(container);
    registerExitHooks();
    logger.debug(`Container ${container.id} started.`);
  }

  /**
   * Runs a command inside the container and returns its decoded output. The
   * exec is created without a TTY so that the stream stays multiplexed and
   * `modem.demuxStream` can split it into stdout and stderr.
   */
  async execute(cmd: string[]): Promise<ExecOutput> {
    if (!this.container) {
      throw new Error('Container is not started.');
    }
    const client = await this.getClient();
    const exec = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({hijack: true, stdin: false});

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    client.modem.demuxStream(stream, stdout, stderr);
    const collected = Promise.all([text(stdout), text(stderr)]);

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    stdout.end();
    stderr.end();

    const [stdoutText, stderrText] = await collected;
    const info = await exec.inspect();
    return {stdout: stdoutText, stderr: stderrText, exitCode: info.ExitCode};
  }

  /**
   * Stops and removes the container. It does nothing when the container was
   * never started. When Docker rejects, the handle is kept so that a later
   * {@link stop} or the exit hook retries the cleanup.
   */
  async stop(): Promise<void> {
    const container = this.container;
    if (!container) {
      return;
    }
    await container.stop();
    await container.remove();
    this.container = undefined;
    activeContainers.delete(container);
    logger.debug(`Container ${container.id} stopped and removed.`);
  }

  /**
   * Resolves the Docker client once, loading dockerode lazily when no client
   * was injected. The promise is memoized rather than the client, so that
   * concurrent callers share one load.
   */
  private getClient(): Promise<Docker> {
    this.clientPromise ??= this.options.docker
      ? Promise.resolve(this.options.docker)
      : loadOptionalPeer(
          {packageName: 'dockerode', feature: 'ContainerCodeExecutor'},
          () => import('dockerode'),
        ).then(
          ({default: Dockerode}) =>
            new Dockerode(
              this.options.baseUrl
                ? parseBaseUrl(this.options.baseUrl)
                : undefined,
            ),
        );
    return this.clientPromise;
  }
}
