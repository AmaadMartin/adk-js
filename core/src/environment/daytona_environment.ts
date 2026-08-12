/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Daytona, Sandbox} from '@daytona/sdk';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {BaseEnvironment, ExecutionResult} from './base_environment.js';

/** Working directory of every sandbox created by this environment. */
const SANDBOX_HOME = '/workspaces';

/** Sandbox time-to-live in seconds when no `timeoutSeconds` is given. */
const DEFAULT_TIMEOUT_SECONDS = 300;

const SECONDS_PER_MINUTE = 60;

/** Sandbox language requested when no `image` is given. */
const SANDBOX_LANGUAGE = 'python';

/** Permissions applied to directories created by {@link writeFile}. */
const DIRECTORY_MODE = '755';

/** Exit code reported for a command killed by the timeout. */
const TIMED_OUT_EXIT_CODE = -1;

// The two codes and two statuses below are stamped by Daytona on the wire.
// They are matched, not authored, so they stay plain constants.
const TIMEOUT_ERROR_CODE = 'PROCESS_EXECUTION_TIMEOUT';
const FILE_NOT_FOUND_ERROR_CODE = 'FILE_NOT_FOUND';
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** Options for {@link DaytonaEnvironment}. */
export interface DaytonaEnvironmentOptions {
  /**
   * Daytona image name used to create the sandbox. Defaults to Daytona's
   * Python snapshot.
   */
  image?: string;
  /**
   * Sandbox time-to-live and default command timeout, in seconds. Defaults
   * to 300.
   */
  timeoutSeconds?: number;
  /** Daytona API key. Falls back to the `DAYTONA_API_KEY` environment variable. */
  apiKey?: string;
  /** Daytona API URL. Falls back to the Daytona Cloud API. */
  apiUrl?: string;
  /** Environment variables set inside the sandbox. */
  envVars?: Record<string, string>;
}

/** Loads the optional Daytona SDK, or throws an actionable install error. */
async function loadDaytonaSdk(): Promise<typeof import('@daytona/sdk')> {
  try {
    return await import('@daytona/sdk');
  } catch (error: unknown) {
    throw new Error(
      'The @daytona/sdk package is required to use DaytonaEnvironment.' +
        ' Install it with `npm install @daytona/sdk`.',
      {cause: error},
    );
  }
}

function isErrorLike(error: unknown): error is object {
  return typeof error === 'object' && error !== null;
}

/**
 * Matches a Daytona error by the machine-readable `code` it carries.
 *
 * Unlike `instanceof`, this still matches when two copies of the SDK are
 * resolved in one runtime, and it needs no runtime handle on the error classes
 * behind the optional import.
 */
function errorHasCode(error: unknown, code: string): boolean {
  return isErrorLike(error) && 'code' in error && error.code === code;
}

/** Matches a Daytona error by the HTTP status it was translated from. */
function errorHasStatus(error: unknown, status: number): boolean {
  return (
    isErrorLike(error) && 'statusCode' in error && error.statusCode === status
  );
}

function messageIncludes(error: unknown, text: string): boolean {
  return (
    isErrorLike(error) &&
    'message' in error &&
    String(error.message).toLowerCase().includes(text)
  );
}

/**
 * Whether a command failure was a timeout.
 *
 * The code is the precise signal; the message check keeps parity with
 * adk-python and still catches transport timeouts that carry no code.
 */
function isTimeoutError(error: unknown): boolean {
  return (
    errorHasCode(error, TIMEOUT_ERROR_CODE) || messageIncludes(error, 'timeout')
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    errorHasCode(error, FILE_NOT_FOUND_ERROR_CODE) ||
    errorHasStatus(error, HTTP_NOT_FOUND)
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    errorHasStatus(error, HTTP_CONFLICT) ||
    messageIncludes(error, 'already exists')
  );
}

/**
 * Resolves a relative path against the sandbox home; absolute paths pass
 * through.
 *
 * Sandbox paths are always POSIX, so this never uses the platform-dependent
 * `path` functions — they would produce a Windows path on a Windows host.
 */
function resolveSandboxPath(filePath: string): string {
  return path.posix.isAbsolute(filePath)
    ? path.posix.normalize(filePath)
    : path.posix.join(SANDBOX_HOME, filePath);
}

/** Ancestor directories of `filePath`, outermost first, excluding `/`. */
function parentDirectories(filePath: string): string[] {
  const segments = path.posix
    .dirname(filePath)
    .split('/')
    .filter((segment) => segment !== '');
  return segments.map(
    (_, index) => `/${segments.slice(0, index + 1).join('/')}`,
  );
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf-8')
    : Buffer.from(content);
}

/** Auto-stop interval in whole minutes, never rounding a live TTL down to 0. */
function autoStopIntervalMinutes(timeoutSeconds: number): number {
  const minutes = Math.floor(timeoutSeconds / SECONDS_PER_MINUTE);
  return minutes === 0 && timeoutSeconds > 0 ? 1 : minutes;
}

/**
 * A persistent remote workspace backed by a Daytona sandbox.
 *
 * Provides file CRUD and shell execution inside an isolated remote sandbox.
 * One sandbox is created on {@link initialize} and deleted on {@link close}.
 *
 * Unlike `LocalEnvironment` there is deliberately no path containment check:
 * the sandbox is the isolation boundary, so an absolute path such as
 * `/etc/hostname` reads the sandbox's own file and cannot reach the host. The
 * command string itself is still arbitrary shell input — it just runs remotely.
 *
 * Commands run in the sandbox's own default directory rather than in
 * {@link workingDir}, matching adk-python: `/workspaces` does not exist on a
 * fresh sandbox, so requesting it would fail every command.
 *
 * Requires the optional `@daytona/sdk` package: `npm install @daytona/sdk`.
 */
@experimental
export class DaytonaEnvironment extends BaseEnvironment {
  /**
   * Set together by {@link initialize} and cleared together by {@link close},
   * so either one being defined implies the other is.
   */
  private sandbox?: Sandbox;
  private client?: Daytona;
  private readonly image?: string;
  private readonly timeoutSeconds: number;
  private readonly apiKey?: string;
  private readonly apiUrl?: string;
  private readonly envVars?: Record<string, string>;

  constructor(options: DaytonaEnvironmentOptions = {}) {
    super();
    this.image = options.image;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.envVars = options.envVars;
  }

  /** @throws If the environment is not initialized. */
  override get workingDir(): string {
    this.assertInitialized();
    return SANDBOX_HOME;
  }

  override async initialize(): Promise<void> {
    if (this.sandbox !== undefined) {
      return;
    }
    const sdk = await loadDaytonaSdk();
    this.client = new sdk.Daytona({apiKey: this.apiKey, apiUrl: this.apiUrl});
    const params = {
      envVars: this.envVars ?? {},
      autoStopInterval: autoStopIntervalMinutes(this.timeoutSeconds),
      autoDeleteInterval: 0,
    };
    // `create` is overloaded on the presence of `image`, so the two calls stay
    // separate: a union-typed params variable defeats overload resolution.
    this.sandbox =
      this.image === undefined
        ? await this.client.create({language: SANDBOX_LANGUAGE, ...params})
        : await this.client.create({image: this.image, ...params});
    this.initialized = true;
  }

  /**
   * Deletes the sandbox and disposes the client.
   *
   * A failed delete still releases the client, so an unreachable sandbox does
   * not leak a websocket for the life of the process.
   */
  override async close(): Promise<void> {
    if (this.sandbox === undefined) {
      return;
    }
    try {
      await this.sandbox.delete();
    } finally {
      this.sandbox = undefined;
      // The client has no `close()`. Disposing it shuts down the event
      // subscription manager and disconnects the websocket dispatcher, which
      // would otherwise leak across initialize/close cycles.
      await this.client![Symbol.asyncDispose]();
      this.client = undefined;
      this.initialized = false;
    }
  }

  /**
   * Executes a shell command in the sandbox.
   *
   * @param command The shell command string to execute.
   * @param timeoutSeconds Maximum execution time in seconds. `undefined` uses
   *   the environment's own `timeoutSeconds`, so the command deadline and the
   *   sandbox time-to-live agree.
   * @returns The exit code, stdout, stderr, and timeout status. A non-zero exit
   *   code is reported in the result, not thrown. Daytona folds stderr into
   *   stdout, so `stderr` is always empty.
   */
  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    const sandbox = await this.ensureSandbox();
    const timeout = Math.trunc(timeoutSeconds ?? this.timeoutSeconds);
    try {
      const response = await sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        timeout,
      );
      return {
        exitCode: response.exitCode,
        // `result` holds the same text as `artifacts.stdout`, and is the only
        // one of the two the SDK always populates.
        stdout: response.artifacts?.stdout ?? response.result,
        stderr: '',
        timedOut: false,
      };
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
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
   * @throws If the environment is not initialized, or if the file is missing.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    const sandbox = await this.ensureSandbox();
    const resolved = resolveSandboxPath(filePath);
    let content: Uint8Array | undefined;
    try {
      content = await sandbox.fs.downloadFile(resolved);
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) {
        throw new Error(`File not found: ${resolved}`, {cause: error});
      }
      throw error;
    }
    if (content === undefined) {
      throw new Error(`File not found: ${resolved}`);
    }
    return content;
  }

  /**
   * Writes a file in the sandbox filesystem, creating parent directories.
   *
   * @param filePath Absolute path, or a path relative to the sandbox home.
   * @param content The string or raw bytes to write.
   * @throws If the environment is not initialized.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sandbox = await this.ensureSandbox();
    const resolved = resolveSandboxPath(filePath);
    for (const directory of parentDirectories(resolved)) {
      try {
        await sandbox.fs.createFolder(directory, DIRECTORY_MODE);
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }
    // A bare string here means a local file path to the SDK, so the content is
    // always converted to a Buffer first.
    await sandbox.fs.uploadFile(toBuffer(content), resolved);
  }

  private async ensureSandbox(): Promise<Sandbox> {
    this.assertInitialized();
    const sandbox = this.sandbox!;
    await sandbox.refreshActivity();
    return sandbox;
  }
}
