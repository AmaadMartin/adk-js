/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Coercion of a record into a form `JSON.stringify` represents faithfully.
 *
 * `JSON.stringify` alone is not enough for data that has to survive a write to
 * a JSON column or a JSON document field: it throws on a `bigint` and on a
 * cycle, and it drops a function, a symbol and a `Map` without a word. A value
 * that vanished silently is far harder to diagnose than one that arrives as a
 * string, so these helpers replace what cannot be represented, and report
 * whether a replacement was needed.
 */

/** Written in place of a value that refers back to its own container. */
const CIRCULAR_PLACEHOLDER = '[Circular]';

const objectTag = Object.prototype.toString;

/**
 * The built-in guards below read the object tag rather than using
 * `instanceof`, so that a value built in another realm — a `vm` context, a
 * worker, a second copy of a package — is still recognised.
 */
function isDate(value: object): value is Date {
  return objectTag.call(value) === '[object Date]';
}

function isMap(value: object): value is Map<unknown, unknown> {
  return objectTag.call(value) === '[object Map]';
}

function isSet(value: object): value is Set<unknown> {
  return objectTag.call(value) === '[object Set]';
}

/**
 * Returns whether `JSON.stringify` represents every value in `record` without
 * losing or rejecting anything.
 *
 * An `undefined` property is not counted as a loss: JSON has no such value and
 * omitting the key is the standard behaviour every JavaScript caller expects.
 * A `Date` is not counted either, because `JSON.stringify` writes its ISO
 * string.
 */
export function isJsonSafe(record: Record<string, unknown>): boolean {
  const seen = new WeakSet<object>([record]);
  return Object.values(record).every((value) => checkValue(value, seen));
}

function checkValue(value: unknown, seen: WeakSet<object>): boolean {
  if (isReplaced(value)) {
    return false;
  }
  if (value === null || typeof value !== 'object') {
    return true;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const safe = checkContainer(value, seen);
  seen.delete(value);
  return safe;
}

function checkContainer(value: object, seen: WeakSet<object>): boolean {
  if (isDate(value)) {
    return true;
  }
  if (isMap(value) || isSet(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => checkValue(item, seen));
  }
  return Object.values(value).every((item) => checkValue(item, seen));
}

/** Whether `value` has no JSON form of its own and is replaced by a string. */
function isReplaced(value: unknown): boolean {
  const type = typeof value;
  return type === 'bigint' || type === 'function' || type === 'symbol';
}

/**
 * Returns `record` with everything `JSON.stringify` cannot represent replaced.
 *
 * A `Date` becomes its ISO string, a `Map` a plain object, a `Set` an array,
 * and a `bigint`, function or symbol its string form. A cycle becomes
 * `'[Circular]'`. An `undefined` property is omitted and an `undefined` array
 * slot becomes `null`, matching `JSON.stringify`. The function never throws.
 */
export function toJsonSafe(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return coerceEntries(Object.entries(record), new WeakSet<object>([record]));
}

function coerceValue(value: unknown, seen: WeakSet<object>): unknown {
  if (isReplaced(value)) {
    return String(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }
  seen.add(value);
  const coerced = coerceContainer(value, seen);
  seen.delete(value);
  return coerced;
}

function coerceContainer(value: object, seen: WeakSet<object>): unknown {
  if (isDate(value)) {
    return value.toISOString();
  }
  if (isMap(value)) {
    return coerceEntries(value.entries(), seen);
  }
  if (isSet(value)) {
    return coerceItems([...value], seen);
  }
  if (Array.isArray(value)) {
    return coerceItems(value, seen);
  }
  return coerceEntries(Object.entries(value), seen);
}

function coerceItems(items: unknown[], seen: WeakSet<object>): unknown[] {
  return items.map((item) => coerceValue(item, seen) ?? null);
}

function coerceEntries(
  entries: Iterable<[unknown, unknown]>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  // Null-prototype: a `__proto__` key copied into a plain object literal
  // invokes the inherited setter, which re-parents the object instead of
  // storing the entry.
  const coerced: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    const item = coerceValue(value, seen);
    if (item !== undefined) {
      coerced[String(key)] = item;
    }
  }
  return coerced;
}
