/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Narrows to a value whose members can be read by key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Returns a copy of `value` whose object keys are sorted lexicographically at
 * every level. Arrays keep their element order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

/**
 * Serializes `value` to JSON with object keys sorted lexicographically at every
 * level, so the same content always produces the same text whatever order its
 * keys were inserted in. Arrays keep their element order, and `undefined`
 * members are dropped as `JSON.stringify` drops them.
 *
 * This is the JavaScript counterpart of Python's
 * `json.dumps(value, sort_keys=True)`. Use it wherever the text has to stay
 * stable across runs, or has to agree with what the Python SDK produces.
 * Cyclic input throws, as it does with `JSON.stringify`.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
