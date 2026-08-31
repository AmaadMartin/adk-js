/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a string to snake_case.
 *
 * Handles lowerCamelCase, UpperCamelCase, space-separated words and acronyms,
 * so `'Mock API'` becomes `'mock_api'` and `'RESTClient'` becomes
 * `'rest_client'`.
 *
 * @param text The string to convert.
 * @returns The snake_case form of the string.
 */
export function toSnakeCase(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_|_$/g, '');
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
