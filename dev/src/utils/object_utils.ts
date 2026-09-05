/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an unknown value — parsed JSON, an imported module namespace — to a
 * keyed object. Arrays are rejected: JSON parses to one, and an array is never
 * the shape a caller reading named keys wants.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
