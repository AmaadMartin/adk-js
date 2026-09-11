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
 * string, so this module replaces what cannot be represented, and reports
 * whether the replacement lost anything.
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

/** What {@link toJsonSafe} produced. */
export interface JsonSafeResult {
  /** The coerced record, safe to hand to `JSON.stringify`. */
  record: Record<string, unknown>;
  /**
   * Whether `JSON.stringify` alone would have thrown or silently dropped
   * something, so the persisted form differs from the value in hand.
   *
   * An `undefined` property does not count: JSON has no such value, and
   * omitting the key is what every JavaScript caller expects. A `Date` does
   * not count either, because `JSON.stringify` writes its ISO string too.
   */
  lossy: boolean;
}

/** The traversal's state: the containers on the path, and what was lost. */
interface Coercion {
  seen: WeakSet<object>;
  lossy: boolean;
}

/**
 * Returns `record` with everything `JSON.stringify` cannot represent replaced.
 *
 * A `Date` becomes its ISO string, a `Map` a plain object, a `Set` an array,
 * and a `bigint`, function or symbol its string form. A cycle becomes
 * `'[Circular]'`. An `undefined` property is omitted and an `undefined` array
 * slot becomes `null`, matching `JSON.stringify`. The function never throws.
 */
export function toJsonSafe(record: Record<string, unknown>): JsonSafeResult {
  const coercion: Coercion = {
    seen: new WeakSet<object>([record]),
    lossy: false,
  };
  return {
    record: coerceEntries(Object.entries(record), coercion),
    lossy: coercion.lossy,
  };
}

/** Whether `value` has no JSON form of its own and is replaced by a string. */
function isReplaced(value: unknown): boolean {
  const type = typeof value;
  return type === 'bigint' || type === 'function' || type === 'symbol';
}

function coerceValue(value: unknown, coercion: Coercion): unknown {
  if (isReplaced(value)) {
    coercion.lossy = true;
    return String(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (coercion.seen.has(value)) {
    coercion.lossy = true;
    return CIRCULAR_PLACEHOLDER;
  }
  coercion.seen.add(value);
  const coerced = coerceContainer(value, coercion);
  coercion.seen.delete(value);
  return coerced;
}

function coerceContainer(value: object, coercion: Coercion): unknown {
  if (isDate(value)) {
    return value.toISOString();
  }
  // A Map and a Set are written faithfully here, but `JSON.stringify` alone
  // writes `{}` for both, and reading either back gives the plain form.
  if (isMap(value)) {
    coercion.lossy = true;
    return coerceEntries(value.entries(), coercion);
  }
  if (isSet(value)) {
    coercion.lossy = true;
    return coerceItems([...value], coercion);
  }
  if (Array.isArray(value)) {
    return coerceItems(value, coercion);
  }
  return coerceEntries(Object.entries(value), coercion);
}

function coerceItems(items: unknown[], coercion: Coercion): unknown[] {
  return items.map((item) => coerceValue(item, coercion) ?? null);
}

function coerceEntries(
  entries: Iterable<[unknown, unknown]>,
  coercion: Coercion,
): Record<string, unknown> {
  // Null-prototype: a `__proto__` key copied into a plain object literal
  // invokes the inherited setter, which re-parents the object instead of
  // storing the entry.
  const coerced: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    const item = coerceValue(value, coercion);
    if (item !== undefined) {
      coerced[String(key)] = item;
    }
  }
  return coerced;
}
