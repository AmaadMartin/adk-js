/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Returns a copy of a plain object whose keys are in sorted order. */
function withSortedKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/**
 * Serializes a value to JSON with object keys sorted at every depth, so that
 * two values that differ only in key order produce identical text.
 *
 * Array order is data and is preserved. Non-ASCII characters stay literal, and
 * the values `JSON.stringify` drops (`undefined`, a function) are dropped here
 * too. Matches Python's `json.dumps(value, ensure_ascii=False,
 * sort_keys=True)`.
 *
 * @param value The value to serialize.
 * @return The JSON text.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => withSortedKeys(entry));
}
