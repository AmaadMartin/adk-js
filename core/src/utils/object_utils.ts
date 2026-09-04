/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an unknown value to a plain (non-array) record.
 *
 * `typeof null` is `'object'` and an array is an object too, so both are
 * excluded: a caller that indexes the result expects named keys.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Alias for {@link isPlainObject}. Callers that name the shape a "record"
 * rather than a "plain object" use this name for the same guard.
 */
export const isRecord: (value: unknown) => value is Record<string, unknown> =
  isPlainObject;
