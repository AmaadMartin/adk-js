/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Daytona, Sandbox} from '@daytona/sdk';
import * as path from 'node:path';
import {
  BaseEnvironment,
  ExecutionResult,
} from '../../environment/base_environment.js';
import {experimental} from '../../utils/experimental.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/** Working directory of every Daytona sandbox. */
const SANDBOX_HOME = '/workspaces';

/** Default sandbox time-to-live, and default per-command timeout, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Language of the Daytona snapshot used when no image is given. */
const SANDBOX_LANGUAGE = 'python';

/** Permission bits applied to a directory this class creates. */
const DIRECTORY_MODE = '755';

const SECONDS_PER_MINUTE = 60;

/** Exit code reported for a command that exceeded its timeout. */
const TIMED_OUT_EXIT_CODE = -1;

const TIMEOUT_MESSAGE = /timeout/i;
const ALREADY_EXISTS_MESSAGE = /already exists/i;

/** The `@daytona/sdk` module namespace, loaded on first use. */
type DaytonaSdk = typeof import('@daytona/sdk');

/** A live Daytona client together with the one sandbox it created. */
interface DaytonaSession {
  sdk: DaytonaSdk;
  client: Daytona;
  sandbox: Sandbox;
}

/** Options for {@link DaytonaEnvironment}. */
export interface DaytonaEnvironmentOptions {
  /**
   * Daytona image used to create the sandbox. When omitted, Daytona's default
   * `python` snapshot is used.
   */
  image?: string;
  /**
   * Sandbox time-to-live, and the default per-command timeout, in seconds.
   * Defaults to 300.
   */
  timeoutSeconds?: number;
  /** Daytona API key. Falls back to the `DAYTONA_API_KEY` variable. */
  apiKey?: string;
  /** Daytona API URL. Falls back to the Daytona Cloud API. */
  apiUrl?: string;
  /** Environment variables set inside the sandbox. */
  envVars?: Record<string, string>;
}

/** Resolves `filePath` against {@link SANDBOX_HOME}; absolute paths pass through. */
function resolveSandboxPath(filePath: string): string {
  // Sandbox paths are POSIX whatever the host is, so the platform-dependent
  // `path.*` members would produce a Windows path on a Windows host.
  return path.posix.resolve(SANDBOX_HOME, filePath);
}

/**
 * Every ancestor directory of `filePath`, outermost first.
 *
 * `/workspaces/sub/nested/file.txt` yields `['/workspaces',
 * '/workspaces/sub', '/workspaces/sub/nested']`. A file directly under `/`
 * yields nothing, because the root always exists.
 */
function parentDirectories(filePath: string): string[] {
  const segments = path.posix.dirname(filePath).split('/').filter(Boolean);
  return segments.map(
    (_, index) => `/${segments.slice(0, index + 1).join('/')}`,
  );
}

/**
 * Converts file content to a `Buffer`.
 *
 * A bare `string` first argument to `uploadFile` means a *local file path* to
 * the SDK, so string content that is not converted silently means something
 * else.
 */
function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf-8')
    : Buffer.from(content);
}

/**
 * Auto-stop interval, in whole minutes, for a sandbox living `timeoutSeconds`.
 *
 * A positive timeout shorter than a minute still gets one minute, because `0`
 * means "never auto-stop" to Daytona.
 */
function autoStopIntervalMinutes(timeoutSeconds: number): number {
  const minutes = Math.floor(timeoutSeconds / SECONDS_PER_MINUTE);
  return minutes === 0 && timeoutSeconds > 0 ? 1 : minutes;
}

/**
 * Whether `err` reports that a command exceeded its timeout.
 *
 * `sdk` is the namespace the client was built from, so the class identities
 * match. The message check catches the detail-less `DaytonaError` the SDK
 * raises when a failure carries no structured metadata to pick a class from.
 */
function isTimeoutError(sdk: DaytonaSdk, err: unknown): boolean {
  return (
    err instanceof sdk.DaytonaTimeoutError ||
    (err instanceof sdk.DaytonaError && TIMEOUT_MESSAGE.test(err.message))
  );
}

/** Whether `err` reports that the requested file does not exist. */
function isFileNotFoundError(sdk: DaytonaSdk, err: unknown): boolean {
  return err instanceof sdk.DaytonaNotFoundError;
}

/** Whether `err` reports that the directory being created already exists. */
function isAlreadyExistsError(sdk: DaytonaSdk, err: unknown): boolean {
  return (
    err instanceof sdk.DaytonaConflictError ||
    (err instanceof Error && ALREADY_EXISTS_MESSAGE.test(err.message))
  );
}

function fileNotFound(resolved: string, cause?: unknown): Error {
  return new Error(`File not found: ${resolved}`, {cause});
}

/**
 * A persistent remote workspace backed by a Daytona sandbox.
 *
 * Runs shell commands and reads and writes files inside an isolated remote
 * sandbox. One sandbox is created by {@link initialize} and deleted by
 * {@link close}.
 *
 * The sandbox is the isolation boundary, so file paths are **not** confined
 * the way {@link LocalEnvironment} confines them: an absolute path such as
 * `/etc/hostname` reads the sandbox's own file and cannot reach the host. The
 * command string is still arbitrary shell input, and the sandbox does not make
 * it safe — it limits where it runs.
 *
 * Daytona folds a command's stderr into its stdout, so {@link ExecutionResult}
 * `stderr` is always `''` here. A caller that separates the two streams on
 * {@link LocalEnvironment} gets everything in `stdout` instead.
 *
 * Requires the optional peer dependency `@daytona/sdk`, which is loaded on
 * first {@link initialize}.
 *
 * ```ts
 * const env = new DaytonaEnvironment({envVars: {STAGE: 'dev'}});
 * await env.initialize();
 * try {
 *   const result = await env.execute('pip install requests');
 * } finally {
 *   await env.close();
 * }
 * ```
 */
@experimental
export class DaytonaEnvironment extends BaseEnvironment {
  private readonly image?: string;
  private readonly timeoutSeconds: number;
  private readonly apiKey?: string;
  private readonly apiUrl?: string;
  private readonly envVars: Record<string, string>;
  private session?: DaytonaSession;

  constructor(options: DaytonaEnvironmentOptions = {}) {
    super();
    this.image = options.image;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.envVars = options.envVars ?? {};
  }

  override get workingDir(): string {
    this.assertInitialized();
    return SANDBOX_HOME;
  }

  /**
   * Creates the sandbox, loading `@daytona/sdk` on the way. Calling it a
   * second time does nothing.
   *
   * @throws If `@daytona/sdk` is not installed, or if the SDK finds no
   *   credential, or if Daytona refuses to create the sandbox.
   */
  override async initialize(): Promise<void> {
    if (this.session !== undefined) {
      return;
    }
    const sdk = await loadOptionalPeer(
      {packageName: '@daytona/sdk', feature: 'DaytonaEnvironment'},
      () => import('@daytona/sdk'),
    );
    const client = new sdk.Daytona({apiKey: this.apiKey, apiUrl: this.apiUrl});
    try {
      this.session = {sdk, client, sandbox: await this.createSandbox(client)};
    } catch (err: unknown) {
      // Nothing else would ever release the client's connections: there is no
      // sandbox, so `close()` returns immediately.
      await client[Symbol.asyncDispose]();
      throw err;
    }
    this.initialized = true;
  }

  /**
   * Deletes the sandbox and releases the client. Calling it a second time does
   * nothing.
   *
   * @throws If Daytona refuses to delete the sandbox. The client is released
   *   and the environment is left uninitialized either way.
   */
  override async close(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    try {
      await session.sandbox.delete();
    } finally {
      this.session = undefined;
      this.initialized = false;
      await session.client[Symbol.asyncDispose]();
    }
  }

  /**
   * Runs `command` in the sandbox.
   *
   * @param command The shell command string to run.
   * @param timeoutSeconds Overrides the timeout given to the constructor.
   *   Truncated to a whole number of seconds, which is what Daytona accepts.
   * @returns The exit code and output. A non-zero exit code is reported here,
   *   not thrown, and a timeout yields `{exitCode: -1, timedOut: true}`.
   */
  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    const {sdk, sandbox} = await this.ensureSession();
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
        // The SDK documents `result` as the same text as `artifacts.stdout`.
        stdout: response.artifacts?.stdout ?? response.result,
        stderr: '',
        timedOut: false,
      };
    } catch (err: unknown) {
      if (isTimeoutError(sdk, err)) {
        return {
          exitCode: TIMED_OUT_EXIT_CODE,
          stdout: '',
          stderr: '',
          timedOut: true,
        };
      }
      throw err;
    }
  }

  /**
   * Reads a file from the sandbox.
   *
   * @param filePath Absolute, or relative to `/workspaces`.
   * @throws `File not found: <path>` if the file does not exist.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    const {sdk, sandbox} = await this.ensureSession();
    const resolved = resolveSandboxPath(filePath);
    let content: Buffer | undefined;
    try {
      content = await sandbox.fs.downloadFile(resolved);
    } catch (err: unknown) {
      if (isFileNotFoundError(sdk, err)) {
        throw fileNotFound(resolved, err);
      }
      throw err;
    }
    if (content === undefined) {
      throw fileNotFound(resolved);
    }
    return content;
  }

  /**
   * Writes a file in the sandbox, creating its parent directories.
   *
   * @param filePath Absolute, or relative to `/workspaces`.
   * @param content A string is encoded as UTF-8.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const {sdk, sandbox} = await this.ensureSession();
    const resolved = resolveSandboxPath(filePath);
    for (const directory of parentDirectories(resolved)) {
      try {
        await sandbox.fs.createFolder(directory, DIRECTORY_MODE);
      } catch (err: unknown) {
        if (!isAlreadyExistsError(sdk, err)) {
          throw err;
        }
      }
    }
    await sandbox.fs.uploadFile(toBuffer(content), resolved);
  }

  private createSandbox(client: Daytona): Promise<Sandbox> {
    const params = {
      envVars: this.envVars,
      autoStopInterval: autoStopIntervalMinutes(this.timeoutSeconds),
      autoDeleteInterval: 0,
    };
    // `create` is overloaded on the presence of `image`, so a single
    // union-typed variable would defeat overload resolution.
    return this.image === undefined
      ? client.create({...params, language: SANDBOX_LANGUAGE})
      : client.create({...params, image: this.image});
  }

  /** Returns the live session, keeping the sandbox from auto-stopping. */
  private async ensureSession(): Promise<DaytonaSession> {
    this.assertInitialized();
    // `initialized` and `session` are set and cleared together.
    const session = this.session!;
    await session.sandbox.refreshActivity();
    return session;
  }
}
