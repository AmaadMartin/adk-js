/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts an identifier to snake_case.
 *
 * A run of non-alphanumeric characters becomes one underscore, a camelCase
 * boundary and the end of an acronym each gain one, and repeated, leading and
 * trailing underscores collapse away. `REST API` becomes `rest_api` and
 * `user-id` becomes `user_id`.
 *
 * This converts a single identifier. {@link camelCaseKeys} and the helpers in
 * `object_notation_utils.ts` walk the keys of an object instead.
 *
 * @param text The identifier to convert.
 * @returns The snake_case identifier.
 */
export function toSnakeCaseIdentifier(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
