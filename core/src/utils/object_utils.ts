/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns whether a value is a plain object literal rather than a class
 * instance such as a node, a tool, an agent or a `Date`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns `value` without its `null` and `undefined` fields, recursively.
 *
 * Array entries all survive, including nulls: the rule drops the fields of an
 * object, not the elements of a list. A class instance is returned as it is
 * rather than rebuilt, because it has no own enumerable fields to copy. The
 * argument is never mutated.
 *
 * This is the JavaScript form of pydantic's `model_dump(exclude_none=True)`,
 * which is how adk-python renders a validated model.
 */
export function stripNullish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripNullish(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, stripNullish(entry)]),
  );
}
