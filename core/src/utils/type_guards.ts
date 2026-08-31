/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows a value to a keyed object.
 *
 * An array is rejected, so a caller that expects an object does not silently
 * accept a list.
 *
 * @param value The value to narrow.
 * @returns True when the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
