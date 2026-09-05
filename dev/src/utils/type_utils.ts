/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows a value to an indexable object, so a caller can read or edit its
 * keys without an unchecked cast. Arrays, `null` and primitives are rejected,
 * which keeps a JSON array from being treated as a key/value map.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
