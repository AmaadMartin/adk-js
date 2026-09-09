/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Readers for decoded JSON, used wherever this package inspects a value that
 * came off the wire and therefore has no compile-time shape.
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

/** Reads a string field, returning `''` when it is absent or not a string. */
export function readString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
