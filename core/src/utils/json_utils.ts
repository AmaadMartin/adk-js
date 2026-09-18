/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared JSON helpers for code that must not fail on a hostile value.
 */

/**
 * Serializes a value for a log line. Never throws.
 *
 * `JSON.stringify` rejects a `BigInt` and a circular structure, both of which
 * a tool can return. A log site must not abort the work it observes, so a
 * `BigInt` becomes its decimal string, a repeated object reference becomes
 * `[Circular]`, and anything else falls back to `String(value)`.
 */
export function stringifyForLog(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === 'bigint') {
          return entry.toString();
        }
        if (typeof entry === 'object' && entry !== null) {
          // A value referenced twice without a cycle also reads as
          // `[Circular]`; a log line is truncated anyway.
          if (seen.has(entry)) {
            return '[Circular]';
          }
          seen.add(entry);
        }
        return entry;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
