/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serialises a value to JSON with object keys sorted at every depth, so two
 * values that differ only in key order produce the same string. Array order is
 * significant and is preserved.
 *
 * Throws whatever `JSON.stringify` throws, e.g. a `TypeError` on a cyclic value
 * or on a `BigInt`.
 *
 * @param value The value to serialise.
 * @returns The canonical JSON form, or `'null'` when `value` has no JSON
 *   representation (`undefined`, a function, or a symbol).
 */
export function canonicalJson(value: unknown): string {
  // Serialise first so `toJSON` hooks run and a cycle is rejected here, then
  // re-serialise the parsed (cycle-free) result with its keys sorted. Sorting
  // on the first pass would hand JSON.stringify a fresh copy of every object,
  // which defeats its cycle detection and overflows the stack instead.
  const json = JSON.stringify(value);
  if (json === undefined) {
    return 'null';
  }
  return JSON.stringify(JSON.parse(json), sortObjectKeys);
}

/** `JSON.stringify` replacer that rewrites each object with sorted keys. */
function sortObjectKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  // Object.fromEntries defines own properties, so a `__proto__` key stays data.
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

/** Narrows a value to a plain (non-array, non-null) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
