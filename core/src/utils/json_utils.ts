/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Readers for decoded JSON, used wherever this package inspects a value that
 * came off the wire and therefore has no compile-time shape.
 *
 * {@link asJsonObject} and {@link asRecord} differ only in how they treat an
 * array. A JSON object never is one, so `asJsonObject` rejects it. A duck-typed
 * value such as an `AggregateError` style `errors` array is still worth
 * inspecting, so `asRecord` accepts it.
 */

/**
 * Narrows an arbitrary value to a plain JSON object, or `undefined` when it is
 * not one.
 */
export function asJsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object. Inspects a duck-typed shape without resorting to
 * `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field, returning `''` when it is absent or not a string. */
export function readString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
