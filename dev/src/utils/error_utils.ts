/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns the message carried by a thrown value.
 *
 * A `catch` binding is `unknown`, and anything can be thrown. This narrows an
 * `Error` to its message and stringifies everything else, so callers can
 * report a failure without casting.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
