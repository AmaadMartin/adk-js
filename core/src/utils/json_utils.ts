/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `JSON.stringify` replacer that reorders the keys of a plain object.
 * Arrays, primitives and `null` pass through. It runs after `toJSON`, so a
 * `Date` reaches it as its ISO string.
 */
function sortKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  // The keys of one object are unique, so the comparator never sees a tie.
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * Serializes `value` to JSON with object keys sorted lexicographically at every
 * level, the JavaScript counterpart of Python's
 * `json.dumps(value, sort_keys=True)`. Arrays keep their element order, and
 * `undefined` members are dropped as `JSON.stringify` drops them.
 *
 * Cyclic input throws a `RangeError`.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, sortKeys);
}
