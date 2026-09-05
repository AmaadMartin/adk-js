/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object. Lets duck-typed shapes such as an error carrying a
 * numeric `status` be inspected without widening to `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Returns the message of a thrown value: the `message` of an `Error`, and the
 * string form of anything else. Never throws.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
