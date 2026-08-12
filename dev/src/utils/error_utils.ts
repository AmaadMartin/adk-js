/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns a readable message for an arbitrary thrown value.
 *
 * A `catch` clause binds whatever was thrown, which is not necessarily an
 * `Error`. Casting that binding with `as Error` only asserts that the type
 * checker is wrong: the property access still yields `undefined` for a thrown
 * string or plain object, and the cause disappears from the log.
 *
 * A value that is not an `Error` stringifies through `String`, so a plain
 * object reports `'[object Object]'`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
