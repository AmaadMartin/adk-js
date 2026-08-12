/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an unknown value to a plain, string-keyed object.
 *
 * Arrays are rejected: they are objects at runtime but are never a valid
 * key/value bag.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
