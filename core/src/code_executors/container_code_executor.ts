/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
} from './code_execution_utils.js';
import {
  DockerContainer,
  type DockerContainerOptions,
} from './docker_container.js';
import {
  PYTHON_TIMEOUT_WRAPPER,
  TIMEOUT_EXIT_CODE,
} from './python_timeout_wrapper.js';

const DEFAULT_IMAGE_TAG = 'adk-code-executor:latest';
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Options for {@link ContainerCodeExecutor}.
 */
export interface ContainerCodeExecutorOptions {
  /** Optional base url of a user-hosted Docker daemon (e.g. `tcp://host:2375`). */
  baseUrl?: string;
  /**
   * Tag of the predefined or custom image to run on the container. Either
   * `image` or `dockerPath` must be set. Defaults to `adk-code-executor:latest`
   * when only `dockerPath` is given.
   */
  image?: string;
  /**
   * Path to a directory containing a Dockerfile. If set, the image is built
   * from it instead of using a prebuilt tag. Either `image` or `dockerPath`
   * must be set.
   */
  dockerPath?: string;
  /**
   * Start the container with networking enabled. Defaults to false so
   * untrusted, model-generated code cannot reach the network (the cloud
   * metadata endpoint, internal services, or exfiltration destinations).
   */
  networkEnabled?: boolean;
  /**
   * Wall-clock bound in seconds on a single execution, enforced inside the
   * container. Must be a positive integer. Defaults to 300.
   */
  timeoutSeconds?: number;
  /**
   * Injected Docker client, primarily for testing so unit tests never touch a
   * real Docker daemon. Defaults to a new client built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * The argv prefix used to run a code string for each supported language; the
 * code is appended as the final argument.
 *
 * TypeScript is run through `npx tsx`, which type-strips and executes in one
 * step, so no separate compile step or `tsconfig` is needed in the image.
 */
const LANGUAGE_RUNTIME_COMMAND_MAP: Partial<
  Record<CodeExecutionLanguage, string[]>
> = {
  [CodeExecutionLanguage.PYTHON]: ['python3', '-c'],
  [CodeExecutionLanguage.JAVASCRIPT]: ['node', '-e'],
  [CodeExecutionLanguage.TYPESCRIPT]: ['npx', '--yes', 'tsx', '--eval'],
  [CodeExecutionLanguage.SHELL]: ['sh', '-c'],
};

/**
 * Appends the timeout notice to what the code wrote to stderr. It is appended
 * rather than assigned: the code's own stderr is the useful diagnostic, but on
 * its own it hides that the supervisor cut the run short.
 */
function withTimeoutNotice(stderr: string, timeoutSeconds: number): string {
  const notice = `Code execution timed out after ${timeoutSeconds} seconds.`;
  return stderr ? `${stderr}\n${notice}` : notice;
}

/**
 * A code executor that runs model-generated code inside a hardened Docker
 * container via the `dockerode` client.
 *
 * Security note: this executor runs model-generated code, which may be
 * influenced by untrusted input (e.g. via prompt injection). By default the
 * container is started with networking disabled and all Linux capabilities
 * dropped so the executed code cannot reach the network (including the cloud
 * metadata endpoint at `169.254.169.254`) or escalate privileges. Networking
 * can be re-enabled via `networkEnabled: true` when the executed code is
 * trusted.
 *
 * Every execution runs under a wall-clock bound inside the container, so a run
 * that never returns cannot pin the container for later callers. See
 * `timeoutSeconds`.
 */
@experimental
export class ContainerCodeExecutor extends BaseCodeExecutor {
  private readonly dockerPath?: string;
  private readonly containerOptions: DockerContainerOptions;
  private readonly timeoutSeconds: number;
  private container?: DockerContainer;
  private initPromise?: Promise<void>;

  constructor(options: ContainerCodeExecutorOptions = {}) {
    super();
    if (!options.image && !options.dockerPath) {
      throw new Error(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
      );
    }
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(this.timeoutSeconds) || this.timeoutSeconds <= 0) {
      throw new Error('timeoutSeconds must be a positive integer.');
    }
    this.dockerPath = options.dockerPath
      ? path.resolve(options.dockerPath)
      : undefined;
    this.containerOptions = {
      image: options.image ?? DEFAULT_IMAGE_TAG,
      networkEnabled: options.networkEnabled ?? false,
      baseUrl: options.baseUrl,
      docker: options.docker,
    };
    // These invariants mirror Python's frozen fields: this executor is never
    // stateful and never optimizes data files.
    this.stateful = false;
    this.optimizeDataFile = false;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code, language} = params.codeExecutionInput;
    // Unlike adk-python (which always shells out to python3), dispatch on the
    // declared language so JS/TS and shell snippets run under the right
    // interpreter instead of being fed to Python and failing at parse time.
    const command = LANGUAGE_RUNTIME_COMMAND_MAP[language];
    if (!command) {
      throw new Error(
        `Unsupported language for ContainerCodeExecutor: ${language}. ` +
          `Supported: ${Object.keys(LANGUAGE_RUNTIME_COMMAND_MAP).join(', ')}.`,
      );
    }
    await this.ensureContainer();
    // One container serves every invocation, so an unbounded run would pin it
    // for all later callers. The supervisor holds the deadline in a process the
    // executed code never runs in, so the code cannot disarm it.
    const {stdout, stderr, exitCode} = await this.container!.execute([
      'python3',
      '-c',
      PYTHON_TIMEOUT_WRAPPER,
      String(this.timeoutSeconds),
      ...command,
      code,
    ]);
    logger.debug(`Executed ${language} code:\n\`\`\`\n${code}\n\`\`\``);
    return {
      stdout,
      stderr:
        exitCode === TIMEOUT_EXIT_CODE
          ? withTimeoutNotice(stderr, this.timeoutSeconds)
          : stderr,
      outputFiles: [],
    };
  }

  /**
   * Stops and removes the container. Safe to call when no container has been
   * started; provided for deterministic teardown in tests and app shutdown.
   */
  async close(): Promise<void> {
    const container = this.container;
    this.container = undefined;
    this.initPromise = undefined;
    await container?.stop();
  }

  /** Lazily builds/starts the container exactly once. */
  private ensureContainer(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initContainer();
    }
    return this.initPromise;
  }

  private async initContainer(): Promise<void> {
    const container = new DockerContainer(this.containerOptions);
    if (this.dockerPath) {
      await container.build(this.dockerPath);
    }
    await container.start();
    this.container = container;

    // Probe python3 after start: it is the baseline the default image
    // guarantees, and assigning `this.container` first means a failure here
    // still leaves the container tracked so `close()` can clean it up.
    const {exitCode} = await container.execute(['which', 'python3']);
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
  }
}
