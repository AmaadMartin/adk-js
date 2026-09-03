/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversion of Bigtable GoogleSQL values into JSON.
 *
 * A query result carries values `JSON.stringify` cannot represent: 64-bit
 * integers, byte strings, timestamps, and the SDK's own struct and map
 * classes. The model reads the result as JSON, so each is turned into a
 * faithful JSON form here rather than being dropped or emitted as `{}`.
 */

/** A value that survives `JSON.stringify` on its way to the model. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};

/** A struct or row: the SDK's `NamedList`, which it does not export. */
interface NamedValues {
  values: unknown[];
  fieldMapping: {fieldNames: Array<string | null>};
}

/** Whether the value carries named fields, as a struct or a row does. */
export function isNamedValues(value: unknown): value is NamedValues {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const mapping = record['fieldMapping'];
  return (
    Array.isArray(record['values']) &&
    mapping !== null &&
    typeof mapping === 'object' &&
    Array.isArray((mapping as Record<string, unknown>)['fieldNames'])
  );
}

/**
 * Whether the value behaves like a `Map`.
 *
 * `instanceof Map` is wrong here: the SDK returns a map column as
 * `EncodedKeyMap`, which *implements* `Map` around a private field rather than
 * extending it, so `instanceof` reports false and the entries would be lost.
 */
function isMapLike(value: object): value is Map<unknown, unknown> {
  return typeof (value as Map<unknown, unknown>).entries === 'function';
}

/**
 * Names a field for the JSON object built from a struct or a row.
 *
 * GoogleSQL allows an unnamed column, and allows two columns to share a name.
 * Both are given the field's index so that no value is lost.
 */
export function fieldName(names: Array<string | null>, index: number): string {
  const name = names[index];
  if (name === null || name === undefined || name === '') {
    return `_${index}`;
  }
  return names.indexOf(name) === index ? name : `${name}_${index}`;
}

/** Turns a struct's or row's fields into a JSON object. */
export function namedValuesToJson(named: NamedValues): {
  [key: string]: JsonValue;
} {
  const fields: {[key: string]: JsonValue} = {};
  named.values.forEach((value, index) => {
    fields[fieldName(named.fieldMapping.fieldNames, index)] =
      toJsonValue(value);
  });
  return fields;
}

/**
 * Converts one GoogleSQL value into JSON.
 *
 * @param value The value the Bigtable SDK produced for a column.
 * @return The same value in a form the model can read.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object') {
    // A 64-bit integer arrives as a `bigint`, which JSON cannot carry and
    // which loses digits as a double, so it keeps its digits as a string.
    return typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
      ? value
      : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString('base64');
  }
  // The SDK returns a timestamp column as `PreciseDate`, which extends `Date`.
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isNamedValues(value)) {
    return namedValuesToJson(value);
  }
  if (isMapLike(value)) {
    const entries: {[key: string]: JsonValue} = {};
    for (const [key, mapped] of value.entries()) {
      entries[String(key)] = toJsonValue(mapped);
    }
    return entries;
  }
  const fields: {[key: string]: JsonValue} = {};
  for (const [key, nested] of Object.entries(value)) {
    fields[key] = toJsonValue(nested);
  }
  return fields;
}
