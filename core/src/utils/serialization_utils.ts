/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Flattens a value into plain, persistable data.
 *
 * A `Set` becomes an array, and a `Map`, a plain object and a class instance
 * all become plain objects. A value carrying `toJSON()` — a `Date`, for one —
 * is dumped through it. Arrays and objects are walked recursively, and a
 * primitive or a function is returned unchanged.
 *
 * A circular structure terminates: the reference that closes the cycle is
 * returned as it is. A `toJSON()` that throws leaves its own value unflattened
 * and does not affect the rest of the tree.
 *
 * Mirrors `google/adk-python` `workflow/_base_node.py::_to_serializable`, which
 * dumps a Pydantic model and recurses through lists and dicts. The container
 * kinds differ because these are the shapes a Zod schema produces.
 */
export function toSerializable(value: unknown): unknown {
  return flatten(value, new Set<object>());
}

/**
 * Flattens one value. `active` holds the objects on the current recursion path,
 * so re-entering one hands back the original reference instead of looping.
 */
function flatten(value: unknown, active: Set<object>): unknown {
  if (value === null || typeof value !== 'object' || active.has(value)) {
    return value;
  }
  active.add(value);
  const flattened = flattenObject(value, active);
  active.delete(value);
  return flattened;
}

/** Flattens a non-null object by container kind. */
function flattenObject(value: object, active: Set<object>): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return flattenList(items, active);
  }
  if (value instanceof Set) {
    return flattenList([...value], active);
  }
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, item] of value) {
      record[String(key)] = item;
    }
    return flattenRecord(record, active);
  }
  if (hasToJson(value)) {
    let dumped: unknown;
    try {
      dumped = value.toJSON();
    } catch {
      return value;
    }
    return flatten(dumped, active);
  }
  return flattenRecord(value, active);
}

/** Flattens every item of a list. */
function flattenList(items: unknown[], active: Set<object>): unknown[] {
  return items.map((item) => flatten(item, active));
}

/** Flattens every own enumerable value of an object into a plain record. */
function flattenRecord(
  source: object,
  active: Set<object>,
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  const entries: Array<[string, unknown]> = Object.entries(source);
  for (const [key, value] of entries) {
    flattened[key] = flatten(value, active);
  }
  return flattened;
}

/** Returns whether `value` carries a callable `toJSON()`. */
function hasToJson(value: object): value is {toJSON(): unknown} {
  return (
    'toJSON' in value &&
    typeof (value as {toJSON: unknown}).toJSON === 'function'
  );
}
