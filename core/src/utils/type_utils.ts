/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an unknown value to a keyed object, so its fields can be read
 * without widening to `any`.
 *
 * Arrays and `null` are rejected, matching Python's `isinstance(x, dict)`, so
 * a caller reading `value['key']` after this guard cannot be reading an array
 * index by mistake.
 *
 * @param value The value to test.
 * @returns Whether `value` is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
