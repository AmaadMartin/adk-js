/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a snake_case name to lowerCamelCase.
 *
 * A name with no underscore is returned unchanged, so an already-camelCase
 * name survives the call. Every later segment is lowercased before its first
 * character is uppercased, so `TWO_WORDS` becomes `twoWords`.
 *
 * This converts one name. `camelCaseKeys` converts the keys of an object and
 * is a different operation.
 *
 * @param value The snake_case name.
 * @returns The lowerCamelCase name.
 */
export function snakeToLowerCamel(value: string): string {
  if (!value.includes('_')) {
    return value;
  }
  return value
    .split('_')
    .map((segment, index) =>
      index === 0
        ? segment.toLowerCase()
        : segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join('');
}

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
      const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
      newObj[camelKey] = camelCaseKeys(obj[key]);
    }
    return newObj;
  }
  return val;
}
