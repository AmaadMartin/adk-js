/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CommandExitError, Sandbox} from 'e2b';
import {posix} from 'node:path';
import {
  BaseEnvironment,
  ExecutionResult,
} from '../../environment/base_environment.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/** E2B's public template, available to every account. */
const DEFAULT_IMAGE = 'base';

/** Default sandbox time-to-live, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Home directory of the sandbox user, and the environment's working dir. */
const SANDBOX_HOME = '/home/user';

/** Exit code reported for a command that exceeded its timeout. */
const TIMED_OUT_EXIT_CODE = -1;

const MILLISECONDS_PER_SECOND = 1000;

const NOT_STARTED_MESSAGE = 'Sandbox is not started. Call initialize() first.';

/**
 * Names the e2b SDK gives the errors this module handles.
 *
 * Matching on `name` rather than `instanceof` is deliberate: the SDK is loaded
 * through a dynamic `import()`, so an application that resolves two copies of
 * `e2b` in one runtime would throw an error built by one copy and test it
 * against the class of the other, and `instanceof` would silently answer false.
 */
enum E2BErrorName {
  COMMAND_EXIT = 'CommandExitError',
  TIMEOUT = 'TimeoutError',
  FILE_NOT_FOUND = 'FileNotFoundError',
}

/** An `Error` carrying a POSIX error code, as `node:fs` raises. */
interface ErrnoError extends Error {
  code: string;
}

/** Options for {@link E2BEnvironment}. */
export interface E2BEnvironmentOptions {
  /**
   * E2B template name or ID used to create the sandbox. Defaults to E2B's
   * public `base` template, available to every user.
   */
  image?: string;
  /**
   * Sandbox time-to-live in seconds. The TTL is reset on every operation.
   * Defaults to 300.
   */
  timeoutSeconds?: number;
  /** E2B API key. Falls back to the `E2B_API_KEY` environment variable. */
  apiKey?: string;
  /** Environment variables set inside the sandbox. */
  envVars?: Record<string, string>;
}

/** Resolves a relative path against the sandbox home. */
function resolveSandboxPath(filePath: string): string {
  return posix.isAbsolute(filePath)
    ? filePath
    : posix.join(SANDBOX_HOME, filePath);
}

function hasErrorName(error: unknown, name: E2BErrorName): boolean {
  return error instanceof Error && error.name === name;
}

function isCommandExitError(error: unknown): error is CommandExitError {
  return hasErrorName(error, E2BErrorName.COMMAND_EXIT);
}

/**
 * Builds the `ENOENT` error a missing file surfaces as, matching what
 * `LocalEnvironment.readFile` propagates from `node:fs`.
 */
function fileNotFoundError(resolved: string, cause: unknown): ErrnoError {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${resolved}'`, {cause}),
    {code: 'ENOENT'},
  );
}

/**
 * Converts file content to a shape the e2b SDK accepts. `files.write` takes a
 * string, an `ArrayBuffer`, a `Blob` or a `ReadableStream`, but not a
 * `Uint8Array`.
 */
function toWritableContent(content: string | Uint8Array): string | Blob {
  // `Uint8Array` is generic over `ArrayBufferLike`, and `BlobPart` accepts only
  // a view over an `ArrayBuffer`, so the copy is what makes this assignable
  // without a cast. Removing it is a compile error, not a runtime one.
  return typeof content === 'string'
    ? content
    : new Blob([new Uint8Array(content)]);
}

/**
 * A persistent remote workspace backed by an E2B sandbox.
 *
 * Provides file CRUD, shell execution, and on-demand software installs
 * (`pip install`, `apt install`) inside a remote sandbox.
 *
 * One sandbox is created on {@link initialize} and killed on {@link close}.
 * The sandbox has a bounded time-to-live (`timeoutSeconds`) to cap credit
 * usage. Every operation extends the TTL, so an actively used workspace never
 * expires mid-use. Once it does expire after a genuine idle period, the next
 * operation recreates a fresh sandbox and workspace state is lost.
 *
 * Unlike `LocalEnvironment`, this class applies no path containment check.
 * The remote sandbox is the isolation boundary, so an absolute path such as
 * `/etc/hostname` reads the sandbox's file and never reaches the host.
 *
 * Requires the optional peer dependency `e2b`: `npm install e2b`.
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
   * Runs a shell command in {@link workingDir}.
   *
   * When `timeoutSeconds` is omitted the command is bounded by the sandbox
   * TTL instead. The e2b SDK caps a command at 60 seconds when the option is
   * absent, and rejects immediately when it is `0`, so neither expresses "no
   * limit"; the TTL is the point at which the sandbox dies and takes the
   * command with it, so it is the real ceiling either way.
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
          (timeoutSeconds ?? this.timeoutSeconds) * MILLISECONDS_PER_SECOND,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
      };
    } catch (error: unknown) {
      if (isCommandExitError(error)) {
        // A non-zero exit code is a normal result, not a failure.
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
   * Reads a file from the sandbox.
   *
   * @throws If the environment is not initialized, or — as `ENOENT` — if the
   *   file does not exist.
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

  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sandbox = await this.ensureSandbox();
    await sandbox.files.write(
      resolveSandboxPath(filePath),
      toWritableContent(content),
    );
  }

  /**
   * Returns the sandbox, narrowing away `undefined`.
   *
   * `this.sandbox !== undefined` holds exactly when `this.initialized` does,
   * so this is the base class's `assertInitialized()` in a form the compiler
   * can narrow on. Calling both would be redundant.
   */
  private requireSandbox(): Sandbox {
    if (this.sandbox === undefined) {
      throw new Error(NOT_STARTED_MESSAGE);
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
      'E2B sandbox expired; recreating a fresh sandbox. Workspace state ' +
        '(installed packages and files) has been lost.',
    );
    this.sandbox = await this.createSandbox();
    return this.sandbox;
  }

  private async createSandbox(): Promise<Sandbox> {
    const e2b = await loadOptionalPeer(
      {packageName: 'e2b', feature: 'E2BEnvironment'},
      () => import('e2b'),
    );
    return e2b.Sandbox.create({
      template: this.image,
      timeoutMs: this.timeoutSeconds * MILLISECONDS_PER_SECOND,
      envs: this.envVars,
      apiKey: this.apiKey,
    });
  }
}
