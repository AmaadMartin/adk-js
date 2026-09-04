/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an unknown value to a plain, non-array record.
 *
 * Use it to read a field off a value whose shape is not known statically —
 * decoded JSON, an API response, a duck-typed error — without widening to
 * `any`. An array is rejected, so indexing the result by a field name cannot
 * silently read an array index.
 *
 * @param value The value to narrow.
 * @return Whether `value` is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
