/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Daytona, Image, Sandbox} from '@daytona/sdk';
import * as posix from 'node:path/posix';
import {
  BaseEnvironment,
  ExecutionResult,
} from '../../environment/base_environment.js';
import {asRecord, formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/** Sandbox lifetime and per-command timeout when the caller gives none, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Directory a relative path is resolved against inside the sandbox. */
const SANDBOX_HOME = '/workspaces';

/** Permissions given to every parent directory {@link DaytonaEnvironment.writeFile} creates. */
const DIRECTORY_MODE = '755';

const SECONDS_PER_MINUTE = 60;

/** Reported by every operation that needs a sandbox before `initialize()` ran. */
const NOT_STARTED_MESSAGE = 'Sandbox is not started. Call initialize() first.';

/** Every error class of the Daytona SDK names itself with this prefix. */
const DAYTONA_ERROR_PREFIX = 'Daytona';

/** `code` of the SDK's `DaytonaProcessExecutionTimeoutError`. */
const PROCESS_EXECUTION_TIMEOUT_CODE = 'PROCESS_EXECUTION_TIMEOUT';

/** `code` of the SDK's `DaytonaFileNotFoundError`. */
const FILE_NOT_FOUND_CODE = 'FILE_NOT_FOUND';

/** `statusCode` the SDK copies from an HTTP 404 response. */
const HTTP_NOT_FOUND = 404;

/** Options for {@link DaytonaEnvironment}. */
export interface DaytonaEnvironmentOptions {
  /** Daytona image used to create the sandbox. A snapshot is used when omitted. */
  image?: string | Image;
  /** Sandbox lifetime and default command timeout, in seconds. Defaults to 300. */
  timeoutSeconds?: number;
  /** Daytona API key. The SDK reads `DAYTONA_API_KEY` when omitted. */
  apiKey?: string;
  /** Daytona API URL. The SDK reads `DAYTONA_API_URL` when omitted. */
  apiUrl?: string;
  /** Environment variables set inside the sandbox. */
  envVars?: Record<string, string>;
  /**
   * A pre-configured client. One is created on `initialize()` when omitted.
   *
   * A client passed here belongs to the caller: `close()` deletes the sandbox
   * but does not dispose the client.
   */
  client?: Daytona;
}

/** The fields every Daytona SDK error carries, read structurally. */
interface DaytonaErrorFields {
  name: string;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
}

/**
 * Returns `err`'s fields when it is a Daytona SDK error, otherwise `undefined`.
 *
 * The SDK names every error class after itself, which is what this matches. A
 * structural check keeps the SDK out of the module's import graph, and keeps
 * working when a runtime holds two copies of it — neither of which is true of
 * `instanceof`.
 */
function daytonaErrorFields(err: unknown): DaytonaErrorFields | undefined {
  const record = asRecord(err);
  if (record === undefined) {
    return undefined;
  }
  const name = record['name'];
  if (typeof name !== 'string' || !name.startsWith(DAYTONA_ERROR_PREFIX)) {
    return undefined;
  }
  return {
    name,
    message: record['message'],
    code: record['code'],
    statusCode: record['statusCode'],
  };
}

/** True when `err` is the SDK reporting that a command exceeded its timeout. */
function isDaytonaTimeout(err: unknown): boolean {
  const fields = daytonaErrorFields(err);
  if (fields === undefined) {
    return false;
  }
  return (
    fields.code === PROCESS_EXECUTION_TIMEOUT_CODE ||
    (typeof fields.message === 'string' && /timeout/i.test(fields.message))
  );
}

/** True when `err` is the SDK reporting that a path does not exist. */
function isDaytonaNotFound(err: unknown): boolean {
  const fields = daytonaErrorFields(err);
  if (fields === undefined) {
    return false;
  }
  return (
    fields.code === FILE_NOT_FOUND_CODE ||
    fields.statusCode === HTTP_NOT_FOUND ||
    fields.name.endsWith('NotFoundError')
  );
}

/**
 * Builds the missing-file error {@link DaytonaEnvironment.readFile} reports.
 *
 * The `ENOENT` code is the one `node:fs` gives `LocalEnvironment`, so both
 * environments report a missing file the same way.
 */
function fileNotFoundError(resolvedPath: string, cause?: unknown): Error {
  return Object.assign(
    new Error(`No such file in the Daytona sandbox: ${resolvedPath}`, {cause}),
    {code: 'ENOENT'},
  );
}

/**
 * Resolves `filePath` against the sandbox working directory.
 *
 * An absolute path is returned unchanged, so it can address the whole sandbox
 * filesystem — this is path resolution, not containment.
 */
function resolvePath(filePath: string): string {
  return posix.isAbsolute(filePath)
    ? filePath
    : posix.join(SANDBOX_HOME, filePath);
}

/**
 * Lists every ancestor directory of `filePath`, root first and `/` excluded.
 *
 * `/workspaces/sub/out.txt` gives `/workspaces` then `/workspaces/sub`.
 */
function ancestorDirectories(filePath: string): string[] {
  const parent = posix.dirname(filePath);
  if (parent === '/') {
    return [];
  }
  const segments = parent.split('/').filter((segment) => segment !== '');
  return segments.map(
    (_, index) => `/${segments.slice(0, index + 1).join('/')}`,
  );
}

/**
 * Converts a sandbox lifetime to the whole minutes Daytona's auto-stop takes.
 *
 * A lifetime under a minute becomes one minute, because Daytona reads zero as
 * "never stop this sandbox".
 */
function autoStopMinutes(timeoutSeconds: number): number {
  const minutes = Math.floor(timeoutSeconds / SECONDS_PER_MINUTE);
  return timeoutSeconds > 0 && minutes === 0 ? 1 : minutes;
}

/** Encodes the body of a write as the `Buffer` the SDK uploads. */
function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf-8')
    : Buffer.from(content);
}

/**
 * A remote workspace backed by a Daytona sandbox.
 *
 * Provides shell execution and file input/output inside an isolated remote
 * sandbox. One sandbox is created on {@link initialize} and deleted on
 * {@link close}. Unlike `LocalEnvironment`, a command never runs on the host,
 * so an untrusted command cannot reach the caller's machine — it can still do
 * anything it likes inside the sandbox.
 *
 * Requires the optional peer dependency `@daytona/sdk`:
 * `npm install @daytona/sdk`. The package is loaded on `initialize()`, so
 * importing this class without it installed still works.
 *
 * Two behaviours differ from `LocalEnvironment` and are not defects:
 * - {@link execute} always reports an empty `stderr`, because Daytona's process
 *   API merges standard error into standard output.
 * - A relative path is resolved against `/workspaces`, but an absolute path
 *   reaches the whole sandbox filesystem. This is path resolution, not
 *   containment.
 *
 * ```ts
 * const env = new DaytonaEnvironment({envVars: {DATASET: 'census'}});
 * await env.initialize();
 * await env.writeFile('analyze.py', 'print("hello")');
 * const result = await env.execute('python analyze.py');
 * await env.close();
 * ```
 */
@experimental
export class DaytonaEnvironment extends BaseEnvironment {
  private readonly image?: string | Image;
  private readonly timeoutSeconds: number;
  private readonly apiKey?: string;
  private readonly apiUrl?: string;
  private readonly envVars?: Record<string, string>;
  /** The client in use, whether the caller supplied it or `initialize()` made it. */
  private client?: Daytona;
  /** Set only for a client this environment made, and therefore has to dispose. */
  private ownedClient?: Daytona;
  private sandbox?: Sandbox;

  constructor(options: DaytonaEnvironmentOptions = {}) {
    super();
    this.image = options.image;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.envVars = options.envVars;
    this.client = options.client;
  }

  /**
   * The directory a relative path is resolved against inside the sandbox.
   *
   * @throws If the sandbox is not started.
   */
  override get workingDir(): string {
    if (this.sandbox === undefined) {
      throw new Error(NOT_STARTED_MESSAGE);
    }
    return SANDBOX_HOME;
  }

  /**
   * Creates the sandbox, and the client when the caller supplied none.
   *
   * Returns immediately when a sandbox is already live.
   *
   * @throws If `@daytona/sdk` is not installed, or if Daytona rejects the
   *   credentials or the create request.
   */
  override async initialize(): Promise<void> {
    if (this.sandbox !== undefined) {
      return;
    }
    if (this.client === undefined) {
      this.ownedClient = await this.createClient();
      this.client = this.ownedClient;
    }
    this.sandbox = await this.createSandbox(this.client);
    this.initialized = true;
  }

  /**
   * Deletes the sandbox, and disposes the client when this environment made it.
   *
   * Returns immediately when no sandbox is live. A client the caller passed to
   * the constructor is left alone: the caller owns it.
   */
  override async close(): Promise<void> {
    if (this.sandbox === undefined) {
      return;
    }
    await this.sandbox.delete();
    this.sandbox = undefined;
    if (this.ownedClient !== undefined) {
      // Releases the client's HTTP sessions, so repeated create/close cycles
      // do not leak sockets.
      await this.ownedClient[Symbol.asyncDispose]();
      this.ownedClient = undefined;
      this.client = undefined;
    }
    this.initialized = false;
  }

  /**
   * Runs a shell command inside the sandbox.
   *
   * `stderr` is always empty: Daytona's process API merges standard error into
   * standard output. A command that exceeds its timeout is reported as
   * `{exitCode: -1, timedOut: true}` rather than thrown.
   *
   * @param command The shell command to run.
   * @param timeoutSeconds Maximum run time. Defaults to the constructor's value.
   * @throws If the sandbox is not started, or on any Daytona failure that is
   *   not a timeout.
   */
  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    const sandbox = await this.ensureSandbox();
    // The SDK wants whole seconds.
    const timeout = Math.floor(timeoutSeconds ?? this.timeoutSeconds);
    try {
      const response = await sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        timeout,
      );
      return {
        exitCode: response.exitCode,
        // `artifacts.stdout` is what the reference implementation reads, and
        // `result` carries the same text when the daemon sends no artifacts.
        stdout: response.artifacts?.stdout ?? response.result,
        stderr: '',
        timedOut: false,
      };
    } catch (err: unknown) {
      if (isDaytonaTimeout(err)) {
        return {exitCode: -1, stdout: '', stderr: '', timedOut: true};
      }
      throw err;
    }
  }

  /**
   * Reads a file from the sandbox.
   *
   * @param filePath Absolute, or relative to `/workspaces`.
   * @throws If the sandbox is not started, or — as `ENOENT` — if the file does
   *   not exist.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    const sandbox = await this.ensureSandbox();
    const resolved = resolvePath(filePath);
    // The SDK declares the body non-nullable. The reference implementation
    // guards against an empty one anyway, so keep the guard.
    let content: Buffer | null | undefined;
    try {
      content = await sandbox.fs.downloadFile(resolved);
    } catch (err: unknown) {
      if (isDaytonaNotFound(err)) {
        throw fileNotFoundError(resolved, err);
      }
      throw err;
    }
    if (content == null) {
      throw fileNotFoundError(resolved);
    }
    return content;
  }

  /**
   * Writes a file in the sandbox, creating its parent directories.
   *
   * A string is encoded as UTF-8; bytes are uploaded unchanged.
   *
   * @param filePath Absolute, or relative to `/workspaces`.
   * @throws If the sandbox is not started, or if Daytona rejects the upload.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sandbox = await this.ensureSandbox();
    const resolved = resolvePath(filePath);
    for (const directory of ancestorDirectories(resolved)) {
      try {
        await sandbox.fs.createFolder(directory, DIRECTORY_MODE);
      } catch (err: unknown) {
        // A directory that already exists is the common case, and a failure
        // that matters surfaces on the upload below. This mirrors the
        // reference implementation, which lets every failure here pass.
        logger.debug(
          `Could not create ${directory} in the Daytona sandbox: ${formatError(err)}`,
        );
      }
    }
    await sandbox.fs.uploadFile(toBuffer(content), resolved);
  }

  /** Loads the SDK and builds a client from the configured credentials. */
  private async createClient(): Promise<Daytona> {
    const {Daytona: DaytonaClient} = await loadOptionalPeer(
      {packageName: '@daytona/sdk', feature: 'DaytonaEnvironment'},
      () => import('@daytona/sdk'),
    );
    // The SDK reads its own environment variables for any field left undefined.
    return new DaytonaClient({apiKey: this.apiKey, apiUrl: this.apiUrl});
  }

  /** Creates the sandbox, from the configured image or from a snapshot. */
  private createSandbox(client: Daytona): Promise<Sandbox> {
    const params = {
      envVars: this.envVars ?? {},
      autoStopInterval: autoStopMinutes(this.timeoutSeconds),
      autoDeleteInterval: 0,
    };
    return this.image === undefined
      ? client.create({language: 'python', ...params})
      : client.create({image: this.image, ...params});
  }

  /** Returns the live sandbox, telling Daytona it is still in use. */
  private async ensureSandbox(): Promise<Sandbox> {
    const sandbox = this.sandbox;
    if (sandbox === undefined) {
      throw new Error(NOT_STARTED_MESSAGE);
    }
    await sandbox.refreshActivity();
    return sandbox;
  }
}
