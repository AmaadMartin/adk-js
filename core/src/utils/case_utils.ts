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
      const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
      newObj[camelKey] = camelCaseKeys(obj[key]);
    }
    return newObj;
  }
  return val;
}

/**
 * Converts a single identifier into snake_case.
 *
 * Separators, lowerCamelCase, UpperCamelCase and acronyms all collapse to
 * single underscores, so `calendar.events.list` becomes `calendar_events_list`
 * and `REST API` becomes `rest_api`.
 *
 * To rename the keys of an object, use `toSnakeCase` from
 * `object_notation_utils.js`. That one keeps separators, because dropping them
 * would break the round-trip back to camelCase.
 *
 * @param text The identifier to convert.
 * @returns The snake_case form of the identifier.
 */
export function toSnakeCaseIdentifier(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}
