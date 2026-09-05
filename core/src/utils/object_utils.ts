/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns whether `value` is an object that can be indexed by name.
 *
 * `typeof null` is `'object'`, so the null check is the whole point of the
 * helper: without it every caller has to remember it, and one of them will
 * not. An array passes, because an array is indexable too.
 *
 * @param value The value to classify.
 * @return True when `value` can be read as a record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Returns whether `value` is an object that is not an array.
 *
 * Use this where an array would be handled by a different branch, so that
 * reading a positional list as a named record cannot happen by accident.
 *
 * @param value The value to classify.
 * @return True when `value` is a record and not an array.
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}
