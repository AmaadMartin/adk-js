/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structural equality for JSON-representable values.
 *
 * Object key order is not significant, which is why this exists instead of a
 * `JSON.stringify` comparison.
 *
 * The scope is JSON: primitives, arrays and plain objects. `Date`, `Map`, `Set`
 * and cyclic values are out of scope. A cyclic value overflows the stack.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && arraysEqual(a, b);
  }

  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }

  return recordsEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  return (
    a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  );
}

function recordsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => key in b && deepEqual(a[key], b[key]))
  );
}
