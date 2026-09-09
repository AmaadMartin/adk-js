/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {setFileLogTarget} from './logger.js';

const LOG_SUB_FOLDER = 'agents_log';
const LOG_FILE_PREFIX = 'agent';

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

/** Mirrors the keyword arguments of adk-python's `log_to_tmp_folder`. */
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
 * Sends the ADK CLI logs to a file under the system temp folder instead of the
 * console, and returns where they went.
 *
 * One file per run, truncated on open and never rotated, as in adk-python. The
 * path is intentionally predictable, because `tail -F
 * <tmp>/agents_log/agent.latest.log` is the point of the feature; on a shared
 * machine another local user may have pre-created the directory.
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

  fs.mkdirSync(logDir, {recursive: true});
  // winston opens its file transport asynchronously, so create the file here:
  // the path this returns is printed to the user and linked below, and both
  // expect it to exist. Python's `FileHandler(mode='w')` is synchronous.
  fs.writeFileSync(logFilePath, '');
  setFileLogTarget(logFilePath);

  return {
    logFilePath,
    latestLogPath: createLatestLogLink(logDir, logFilePath),
  };
}
