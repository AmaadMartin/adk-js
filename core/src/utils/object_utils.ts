/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows a value to a plain object — an object literal, not an array and not
 * a class instance.
 *
 * ADK uses this wherever "data the caller wrote down" has to be told apart
 * from "an object with behaviour": a routing map from a node, or a value to
 * recurse into rather than dump.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
