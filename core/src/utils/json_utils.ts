/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializes `value` to JSON with object keys sorted at every depth.
 *
 * Two values that differ only in the order their keys were inserted produce
 * byte-identical text, so a prompt built from them caches identically. Array
 * order is preserved, and non-ASCII characters stay literal.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : entry,
  );
}
