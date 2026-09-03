/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursively converts snake_case keys of an object to camelCase.
 *
 * @param val The value to convert.
 * @returns The converted value.
 */
export function camelCaseKeys(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(camelCaseKeys);
  }
  if (val !== null && typeof val === 'object' && val.constructor === Object) {
    const obj = val as Record<string, unknown>;
    const newObj: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      newObj[toCamelCase(key)] = camelCaseKeys(obj[key]);
    }
    return newObj;
  }
  return val;
}

/**
 * Converts the snake_case keys of a plain object to camelCase, without
 * recursing into the values.
 *
 * Use this where only the object's own keys belong to a known schema and the
 * values carry data whose keys must survive verbatim, such as the arguments a
 * configuration file passes to a tool.
 *
 * @param val The value to convert.
 * @returns The converted value, or `val` itself when it is not a plain object.
 */
export function camelCaseTopLevelKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object' || val.constructor !== Object) {
    return val;
  }
  const obj = val as Record<string, unknown>;
  const newObj: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    newObj[toCamelCase(key)] = obj[key];
  }
  return newObj;
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
}
