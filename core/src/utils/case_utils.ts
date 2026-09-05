/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts one property name to snake_case.
 *
 * Splits camel humps, folds case, and treats `-` as a word separator, so
 * `topP`, `X-Api-Key` and `api_key` all reach the form a wire field uses.
 * `toSnakeCase` in `object_notation_utils.ts` rewrites the keys of a whole
 * object and escapes differently; this one takes a single name.
 *
 * @param name The property name to convert.
 * @returns The snake_case form of the name.
 */
export function toSnakeCaseName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll('-', '_');
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
