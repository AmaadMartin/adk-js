/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an arbitrary value to a keyed record.
 *
 * An array is rejected: it is an object, but a caller that reads named keys
 * off it wants a dictionary, not a list.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
