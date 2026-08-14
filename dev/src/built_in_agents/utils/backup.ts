/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Timestamped backup copies taken before a write or a delete. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Formats `date` as `YYYYMMDD_HHmmss` in local time. */
function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Builds the backup path for `filePath`, mirroring Python's
 * `with_suffix(f".backup_{ts}{suffix}")`: the timestamp replaces the extension
 * and the extension is appended after it, so `agent.yaml` becomes
 * `agent.backup_20260814_120000.yaml`.
 *
 * @param filePath The file about to be overwritten or deleted.
 * @param date The moment the backup is taken.
 * @return The path of the backup copy.
 */
export function backupPathFor(filePath: string, date: Date): string {
  const extension = path.extname(filePath);
  const withoutExtension = filePath.slice(
    0,
    filePath.length - extension.length,
  );
  return `${withoutExtension}.backup_${formatTimestamp(date)}${extension}`;
}

/**
 * Copies `filePath` to a timestamped sibling, preserving its modification
 * times the way Python's `shutil.copy2` does.
 *
 * @param filePath The file to back up.
 * @return The path of the backup copy.
 * @throws If the copy fails.
 */
export async function createBackup(filePath: string): Promise<string> {
  const backupPath = backupPathFor(filePath, new Date());
  await fs.copyFile(filePath, backupPath);
  const {atime, mtime} = await fs.stat(filePath);
  await fs.utimes(backupPath, atime, mtime);
  return backupPath;
}
