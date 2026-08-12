/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CommandExitError, Sandbox} from 'e2b';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseEnvironment, ExecutionResult} from './base_environment.js';

/** E2B template used when no `image` is given. */
const DEFAULT_IMAGE = 'base';

/** Sandbox time-to-live in seconds when no `timeoutSeconds` is given. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Working directory of every sandbox created by this environment. */
const SANDBOX_HOME = '/home/user';

/** Exit code reported for a command killed by the timeout. */
const TIMED_OUT_EXIT_CODE = -1;

/** The `timeoutMs` value that disables the e2b command timeout. */
const NO_COMMAND_TIMEOUT_MS = 0;

const MILLISECONDS_PER_SECOND = 1000;

/** The `name` e2b assigns to each error class this environment translates. */
enum E2BErrorName {
  COMMAND_EXIT = 'CommandExitError',
  TIMEOUT = 'TimeoutError',
  FILE_NOT_FOUND = 'FileNotFoundError',
}

/** Options for {@link E2BEnvironment}. */
export interface E2BEnvironmentOptions {
  /**
   * E2B template name or ID used to create the sandbox. Defaults to E2B's
   * public `base` template, available to every user.
   */
  image?: string;
  /**
   * Sandbox time-to-live in seconds, reset on every operation. Defaults to 300.
   */
  timeoutSeconds?: number;
  /** E2B API key. Falls back to the `E2B_API_KEY` environment variable. */
  apiKey?: string;
  /** Environment variables set inside the sandbox. */
  envVars?: Record<string, string>;
}

/** Resolves a relative path against the sandbox home; absolute paths pass through. */
function resolveSandboxPath(filePath: string): string {
  return path.posix.isAbsolute(filePath)
    ? filePath
    : path.posix.join(SANDBOX_HOME, filePath);
}

/**
 * Matches an e2b error by its `name`.
 *
 * The SDK sets `name` in every one of its error constructors. Unlike
 * `instanceof`, this still matches when two copies of the SDK are resolved in
 * one runtime.
 */
function hasErrorName(error: unknown, name: E2BErrorName): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === name
  );
}

/** Narrows a thrown value to e2b's `CommandExitError`. */
function isCommandExitError(error: unknown): error is CommandExitError {
  return hasErrorName(error, E2BErrorName.COMMAND_EXIT);
}

/** An error carrying a POSIX error code, as thrown by `node:fs`. */
interface ErrnoError extends Error {
  code: string;
}

/** Builds the missing-file error that `fs.readFile` throws for the same cause. */
function fileNotFoundError(filePath: string, cause: unknown): ErrnoError {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${filePath}'`, {cause}),
    {code: 'ENOENT'},
  );
}

/**
 * A persistent remote workspace backed by an E2B sandbox.
 *
 * Provides file CRUD, shell execution, and on-demand software installs
 * (e.g. `pip install`, `apt install`) inside an isolated remote sandbox.
 *
 * One sandbox is created on {@link initialize} and killed on {@link close}. The
 * sandbox has a bounded time-to-live (`timeoutSeconds`) to cap credit usage.
 * Every operation extends the TTL so an actively used workspace never expires
 * mid-use; once it does expire after genuine idle, the next operation
 * transparently recreates a fresh sandbox and workspace state (installed
 * packages and files) is lost.
 *
 * Unlike `LocalEnvironment` there is deliberately no path containment check:
 * the sandbox is the isolation boundary, so an absolute path such as
 * `/etc/hostname` reads the sandbox's own file and cannot reach the host.
 *
 * Requires the optional `e2b` package: `npm install e2b`.
 */
@experimental
export class E2BEnvironment extends BaseEnvironment {
  private sandbox?: Sandbox;
  private readonly image: string;
  private readonly timeoutSeconds: number;
  private readonly apiKey?: string;
  private readonly envVars?: Record<string, string>;

  constructor(options: E2BEnvironmentOptions = {}) {
    super();
    this.image = options.image ?? DEFAULT_IMAGE;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.apiKey = options.apiKey;
    this.envVars = options.envVars;
  }

  /** @throws If the sandbox is not started. */
  override get workingDir(): string {
    this.requireSandbox();
    return SANDBOX_HOME;
  }

  override async initialize(): Promise<void> {
    if (this.sandbox !== undefined) {
      return;
    }
    this.sandbox = await this.createSandbox();
    this.initialized = true;
  }

  override async close(): Promise<void> {
    if (this.sandbox === undefined) {
      return;
    }
    await this.sandbox.kill();
    this.sandbox = undefined;
    this.initialized = false;
  }

  /**
   * Executes a shell command in the sandbox home directory.
   *
   * @param command The shell command string to execute.
   * @param timeoutSeconds Maximum execution time in seconds. `undefined` means
   *   no limit.
   * @returns The exit code, stdout, stderr, and timeout status. A non-zero exit
   *   code is reported in the result, not thrown.
   */
  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    const sandbox = await this.ensureSandbox();
    try {
      const result = await sandbox.commands.run(command, {
        cwd: SANDBOX_HOME,
        timeoutMs:
          timeoutSeconds === undefined
            ? NO_COMMAND_TIMEOUT_MS
            : timeoutSeconds * MILLISECONDS_PER_SECOND,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
      };
    } catch (error: unknown) {
      if (isCommandExitError(error)) {
        return {
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
          timedOut: false,
        };
      }
      if (hasErrorName(error, E2BErrorName.TIMEOUT)) {
        return {
          exitCode: TIMED_OUT_EXIT_CODE,
          stdout: '',
          stderr: '',
          timedOut: true,
        };
      }
      throw error;
    }
  }

  /**
   * Reads a file from the sandbox filesystem.
   *
   * @param filePath Absolute path, or a path relative to the sandbox home.
   * @throws If the sandbox is not started, or — as `ENOENT` — if the file does
   *   not exist.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    const sandbox = await this.ensureSandbox();
    const resolved = resolveSandboxPath(filePath);
    try {
      return await sandbox.files.read(resolved, {format: 'bytes'});
    } catch (error: unknown) {
      if (hasErrorName(error, E2BErrorName.FILE_NOT_FOUND)) {
        throw fileNotFoundError(resolved, error);
      }
      throw error;
    }
  }

  /**
   * Writes a file in the sandbox filesystem, creating parent directories.
   *
   * @param filePath Absolute path, or a path relative to the sandbox home.
   * @param content The string or raw bytes to write.
   * @throws If the sandbox is not started.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sandbox = await this.ensureSandbox();
    // The SDK takes a Blob rather than raw bytes. `Uint8Array` may be backed by
    // a `SharedArrayBuffer`, which `Blob` does not accept, so copy into a view
    // that is always backed by an `ArrayBuffer`.
    const data =
      typeof content === 'string'
        ? content
        : new Blob([new Uint8Array(content)]);
    await sandbox.files.write(resolveSandboxPath(filePath), data);
  }

  private requireSandbox(): Sandbox {
    if (this.sandbox === undefined) {
      throw new Error('Sandbox is not started. Call initialize() first.');
    }
    return this.sandbox;
  }

  /** Returns a live sandbox, extending its TTL or replacing an expired one. */
  private async ensureSandbox(): Promise<Sandbox> {
    const sandbox = this.requireSandbox();
    if (await sandbox.isRunning()) {
      await sandbox.setTimeout(this.timeoutSeconds * MILLISECONDS_PER_SECOND);
      return sandbox;
    }
    logger.warn(
      'E2B sandbox expired; recreating a fresh sandbox. Workspace state' +
        ' (installed packages and files) has been lost.',
    );
    this.sandbox = await this.createSandbox();
    return this.sandbox;
  }

  private async createSandbox(): Promise<Sandbox> {
    let sdk: {Sandbox: typeof Sandbox};
    try {
      sdk = await import('e2b');
    } catch (error: unknown) {
      throw new Error(
        'The `e2b` package is required to use E2BEnvironment. Install it with' +
          ' `npm install e2b`.',
        {cause: error},
      );
    }
    return sdk.Sandbox.create({
      template: this.image,
      timeoutMs: this.timeoutSeconds * MILLISECONDS_PER_SECOND,
      envs: this.envVars,
      apiKey: this.apiKey,
    });
  }
}
