/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursively converts the snake_case keys of a plain object to camelCase.
 *
 * Use this rather than {@link camelCaseKeys} when the input is already known to
 * be an object, so the result does not have to be narrowed again.
 *
 * @param value The object to convert.
 * @returns An object with camelCase keys.
 */
export function camelCaseRecordKeys(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
    converted[camelKey] = camelCaseKeys(value[key]);
  }
  return converted;
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
    return camelCaseRecordKeys(val as Record<string, unknown>);
  }
  return val;
}
