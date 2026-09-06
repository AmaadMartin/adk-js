/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a single snake_case key to camelCase.
 *
 * A key that holds no underscore comes back unchanged, so an already-camelCase
 * key survives the call.
 *
 * @param key The key to convert.
 * @returns The camelCase key.
 */
export function camelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
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
      newObj[camelCase(key)] = camelCaseKeys(obj[key]);
    }
    return newObj;
  }
  return val;
}
