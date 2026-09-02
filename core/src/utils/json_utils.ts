/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rebuilds `value` with the keys of every object sorted, at every depth.
 *
 * A replacer array on `JSON.stringify` cannot do this. The replacer applies at
 * every depth, so a key list taken from the top level drops the nested keys
 * that are not in it.
 */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = withSortedKeys(source[key]);
  }
  return sorted;
}

/**
 * Serializes `value` to JSON with object keys sorted at every depth.
 *
 * Two values that differ only in the order their keys were inserted produce
 * byte-identical text, so a prompt built from them caches identically. Array
 * order is preserved, and non-ASCII characters stay literal.
 *
 * The input is JSON data — a value decoded from JSON, as a model's tool
 * arguments are. A value carrying a `toJSON` method is rebuilt as a plain
 * object, not passed to that method.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(withSortedKeys(value));
}
