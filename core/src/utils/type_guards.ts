/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether `value` is a keyed object, narrowing it so its keys can be read.
 *
 * An array is not a record here: code that indexes by name wants the object
 * form, and `typeof [] === 'object'` would otherwise let an array through.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
