/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns true if the given error is a "file/directory not found" (`ENOENT`)
 * filesystem error, used to map missing files to nullish/empty results.
 */
export function isFileNotFoundError(error: unknown): boolean {
  return (error as {code?: string})?.code === 'ENOENT';
}
