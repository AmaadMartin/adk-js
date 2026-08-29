/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {LOG_FILE_MODE, setFileLogTarget} from './logger.js';

const LOG_SUB_FOLDER = 'agents_log';
const LOG_FILE_PREFIX = 'agent';

/**
 * Owner-only permissions for the log folder, matching {@link LOG_FILE_MODE}.
 * An existing folder keeps the permissions it has: it may belong to another
 * local user, and this process is in no position to change them.
 */
const LOG_DIR_MODE = 0o700;

/** Where this run's logs are going. */
export interface TmpFolderLog {
  /** Absolute path of this run's log file. Always present. */
  logFilePath: string;
  /**
   * Absolute path of the stable `latest` symlink, or undefined when it could
   * not be created: a real file is in the way, or the platform refused.
   */
  latestLogPath?: string;
}

/**
 * Test seam. No production caller passes these. The tests override them so
 * that the suite writes to a folder of its own and never to the developer's
 * real `<temp>/agents_log`.
 */
export interface LogToTmpFolderOptions {
  /** Directory under the system temp root. Default `'agents_log'`. */
  subFolder?: string;
  /** Timestamp segment. Default `YYYYMMDD_HHmmss` of the current local time. */
  logFileTimestamp?: string;
}

/** Local-time `YYYYMMDD_HHmmss`, matching Python's `%Y%m%d_%H%M%S`. */
function formatLogTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Points `agent.latest.log` at `logFilePath` so `tail -F` survives a restart,
 * and returns the link path.
 *
 * Returns undefined and keeps running when the link cannot be made: a real
 * file already occupies the path, or the platform refuses symlinks (Windows
 * without developer mode). Logging must never stop the run.
 */
export function createLatestLogLink(
  logDir: string,
  logFilePath: string,
): string | undefined {
  const linkPath = path.join(logDir, `${LOG_FILE_PREFIX}.latest.log`);
  const existing = fs.lstatSync(linkPath, {throwIfNoEntry: false});
  if (existing?.isSymbolicLink()) {
    fs.unlinkSync(linkPath);
  } else if (existing) {
    // `process.emitWarning` rather than a logger: it writes to stderr
    // independently, so it stays visible once the logs move to the file.
    process.emitWarning(
      `Cannot create symlink for latest log file: file exists at ${linkPath}`,
    );
    return undefined;
  }

  try {
    fs.symlinkSync(logFilePath, linkPath);
  } catch {
    return undefined;
  }
  return linkPath;
}

/**
 * Creates this run's log file empty, or truncates the file an earlier run left
 * under the same name, as adk-python's `FileHandler(mode='w')` does. winston
 * opens its transport asynchronously, so the file has to exist before this
 * returns: the caller prints the path and links to it.
 *
 * `O_NOFOLLOW` makes the call fail rather than follow a symlink at the last
 * path segment. The folder name is fixed, so on a shared machine another local
 * user can reach the name first, and opening the path would then truncate
 * whatever the symlink aims at. This is a guard, not a sandbox: it does not
 * cover a symlink earlier in the path, and Windows does not support the flag.
 */
function createLogFile(logFilePath: string): void {
  const {O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW} = fs.constants;
  const flags = O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0);
  fs.closeSync(fs.openSync(logFilePath, flags, LOG_FILE_MODE));
}

/**
 * Sends the ADK CLI logs to a file under the system temp folder instead of the
 * console, and returns where they went.
 *
 * One file per run, truncated on open and never rotated, as in adk-python. The
 * path is intentionally predictable, because `tail -F
 * <tmp>/agents_log/agent.latest.log` is the point of the feature. That is also
 * why the folder and the file are owner-only: the log holds model prompts and
 * responses, and a predictable name in a world-traversable temp folder would
 * otherwise hand them to every local user. A folder that already exists keeps
 * the permissions it has.
 */
export function logToTmpFolder(
  options: LogToTmpFolderOptions = {},
): TmpFolderLog {
  const {
    subFolder = LOG_SUB_FOLDER,
    logFileTimestamp = formatLogTimestamp(new Date()),
  } = options;

  const logDir = path.join(os.tmpdir(), subFolder);
  const logFilePath = path.join(
    logDir,
    `${LOG_FILE_PREFIX}.${logFileTimestamp}.log`,
  );

  fs.mkdirSync(logDir, {recursive: true, mode: LOG_DIR_MODE});
  createLogFile(logFilePath);
  setFileLogTarget(logFilePath);

  return {
    logFilePath,
    latestLogPath: createLatestLogLink(logDir, logFilePath),
  };
}
