/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {realpathNonStrict} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {
  killCommand,
  toExitCode,
  USE_PROCESS_GROUP,
} from '../utils/process_utils.js';
import {BaseEnvironment, ExecutionResult} from './base_environment.js';

/** Prefix for the temporary workspace created when no `workingDir` is given. */
const TEMP_WORKSPACE_PREFIX = 'adk_workspace_';

/** Options for {@link LocalEnvironment}. */
export interface LocalEnvironmentOptions {
  /**
   * Absolute path to the workspace directory. Created by
   * {@link LocalEnvironment.initialize} if it does not exist, and never deleted
   * by {@link LocalEnvironment.close}. If omitted, a temporary directory is
   * created on `initialize()` and removed on `close()`.
   */
  workingDir?: string;
  /** Extra variables merged over `process.env` for every executed command. */
  envVars?: Record<string, string>;
}

/**
 * Resolves `filePath` against `workingDir` and rejects anything outside it.
 *
 * Both sides are resolved through their symlinks first, so a link inside the
 * workspace that points out of it is rejected. This is still not a sandbox: it
 * does not survive hardlinks, bind mounts, or a TOCTOU race against a link
 * created after the check. It is a guard against accidental traversal, not a
 * security boundary.
 *
 * @throws If the resolved path is not inside `workingDir`.
 */
async function resolvePathInWorkingDir(
  workingDir: string,
  filePath: string,
): Promise<string> {
  const base = await realpathNonStrict(path.resolve(workingDir));
  const resolved = await realpathNonStrict(path.resolve(base, filePath));
  const relative = path.relative(base, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    // `path.relative` returns an absolute path across Windows drives.
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes working directory: ${filePath}`);
  }
  return resolved;
}

/**
 * Executes commands via local child processes, scoped to a working directory.
 *
 * When `workingDir` is not specified, a temporary directory is created on
 * {@link initialize} and removed on {@link close}.
 *
 * WARNING: this class runs arbitrary shell strings on the host with **no
 * sandboxing** and no sanitisation — the caller is responsible for trusting the
 * command. It is a building block; tools built on top of it are responsible for
 * gating execution behind an explicit user confirmation.
 *
 * A timeout or an abort sends `SIGTERM` to the command's process group, waits
 * five seconds, then escalates to `SIGKILL`, so everything the command started
 * is reaped rather than left behind.
 *
 * Further limitations, all shared with the adk-python reference implementation:
 * - stdout and stderr are buffered fully in memory with no cap, so a command
 *   producing unbounded output will grow the heap until it fails.
 * - The child inherits the whole of `process.env`, so any secret in the parent
 *   environment is visible to the command.
 * - Windows has no process group, so only the spawned shell is signalled there
 *   and a process it forked can survive. Anything such a survivor writes after
 *   the kill is lost, and it keeps the working directory locked, so a
 *   {@link close} following a timeout can fail to remove a temporary workspace.
 * - File paths are confined to the working directory by a symlink-resolved
 *   check that is still not a sandbox (see {@link readFile} and
 *   {@link writeFile}).
 */
@experimental
export class LocalEnvironment extends BaseEnvironment {
  private currentWorkingDir?: string;
  private readonly envVars?: Record<string, string>;
  private autoCreated = false;

  constructor(options: LocalEnvironmentOptions = {}) {
    super();
    this.currentWorkingDir = options.workingDir;
    this.envVars = options.envVars;
  }

  override get workingDir(): string {
    if (this.currentWorkingDir === undefined) {
      throw new Error('`workingDir` is not set. Call initialize() first.');
    }
    return this.currentWorkingDir;
  }

  override async initialize(): Promise<void> {
    if (this.currentWorkingDir === undefined) {
      this.currentWorkingDir = await fs.mkdtemp(
        path.join(os.tmpdir(), TEMP_WORKSPACE_PREFIX),
      );
      this.autoCreated = true;
      logger.debug(`Created temporary workspace: ${this.currentWorkingDir}`);
    } else {
      await fs.mkdir(this.currentWorkingDir, {recursive: true});
    }
    this.initialized = true;
  }

  override async close(): Promise<void> {
    if (this.autoCreated && this.currentWorkingDir !== undefined) {
      await fs.rm(this.currentWorkingDir, {recursive: true, force: true});
      logger.debug(`Removed temporary workspace: ${this.currentWorkingDir}`);
      this.currentWorkingDir = undefined;
    }
    this.initialized = false;
  }

  override async execute(
    command: string,
    timeoutSeconds?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutionResult> {
    this.assertInitialized();
    abortSignal?.throwIfAborted();

    const child = spawn(command, {
      shell: true,
      cwd: this.workingDir,
      env: {...process.env, ...this.envVars},
      // Lead a process group, so a timeout or an abort reaches everything the
      // command started rather than the shell alone.
      detached: USE_PROCESS_GROUP,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // 'close' rather than 'exit': the stdio streams are drained by then, and a
    // descendant holding them open is exactly what teardown has to survive.
    const closed = new Promise<void>((resolve, reject) => {
      child.on('close', () => resolve());
      child.on('error', reject);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    // The abort case carries its reason rather than re-deriving it later, so
    // the throw below cannot depend on `abortSignal` still being in scope.
    const interrupted = new Promise<'timeout' | {abortReason: unknown}>(
      (resolve) => {
        if (timeoutSeconds !== undefined) {
          timer = setTimeout(() => resolve('timeout'), timeoutSeconds * 1000);
        }
        if (abortSignal !== undefined) {
          const abort = abortSignal;
          const listener = () => resolve({abortReason: abort.reason});
          abort.addEventListener('abort', listener, {once: true});
          removeAbortListener = () =>
            abort.removeEventListener('abort', listener);
        }
      },
    );

    try {
      const interruption = await Promise.race([
        closed.then(() => undefined),
        interrupted,
      ]);
      if (interruption !== undefined) {
        await killCommand(child, closed);
        if (interruption !== 'timeout') {
          throw interruption.abortReason;
        }
      }
      return {
        exitCode: toExitCode(child.exitCode, child.signalCode),
        // Decode once, so a multi-byte character split across two chunks is
        // not corrupted. Invalid bytes become U+FFFD, matching Python's
        // `errors='replace'`.
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut: interruption === 'timeout',
      };
    } finally {
      clearTimeout(timer);
      removeAbortListener?.();
    }
  }

  /**
   * Reads a file from the working directory.
   *
   * `filePath` is confined to the working directory by a symlink-resolved
   * check on the resolved path, which is not a sandbox.
   *
   * @throws If the environment is not initialized, if the path escapes the
   *   working directory, or — as `ENOENT` — if the file does not exist.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    this.assertInitialized();
    return fs.readFile(
      await resolvePathInWorkingDir(this.workingDir, filePath),
    );
  }

  /**
   * Writes a file in the working directory, creating parent directories.
   *
   * `filePath` is confined to the working directory by a symlink-resolved
   * check on the resolved path, which is not a sandbox. No newline translation
   * is applied, so explicit CRLF sequences are preserved.
   *
   * @throws If the environment is not initialized or the path escapes the
   *   working directory.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.assertInitialized();
    const resolved = await resolvePathInWorkingDir(this.workingDir, filePath);
    await fs.mkdir(path.dirname(resolved), {recursive: true});
    await fs.writeFile(resolved, content);
  }
}
