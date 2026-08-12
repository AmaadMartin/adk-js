/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns whether the value is a plain object, i.e. an object literal rather
 * than an array, a `null`, or a class instance.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && value.constructor === Object
  );
}

/**
 * Recursively merges `override` into `base`.
 *
 * Two values under the same key are combined only when both are plain
 * objects. Everything else is a leaf: the value from `override` replaces the
 * value from `base`. Arrays, `null`, and class instances are leaves, so
 * arrays are replaced rather than concatenated and a class instance keeps its
 * prototype.
 *
 * The result is a new object. Neither argument is modified, and leaf values
 * are copied by reference. Keys of `base` keep their position and keys new to
 * `override` are appended. The input must be acyclic; a cyclic input is
 * outside the contract and overflows the stack.
 *
 * The `__proto__` key is skipped, because merged data is tool output and
 * assigning through that key would let it reassign a prototype.
 *
 * This mirrors `deep_merge_dicts` in adk-python
 * (`src/google/adk/flows/llm_flows/functions.py`).
 *
 * @param base The object to merge into.
 * @param override The object whose entries win on a leaf collision.
 * @returns A new object holding the merged entries.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {...base};
  for (const key of Object.keys(override)) {
    if (key === '__proto__') continue;
    const current = result[key];
    const next = override[key];
    result[key] =
      isPlainObject(current) && isPlainObject(next)
        ? deepMerge(current, next)
        : next;
  }
  return result;
}
