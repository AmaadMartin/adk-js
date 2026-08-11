/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a plain object. Arrays are excluded, so a caller that reads named
 * properties off the result cannot be handed a list by mistake.
 *
 * @param value The value to narrow.
 * @return The value as an indexable record, or `undefined`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
