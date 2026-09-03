/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Any value that survives a JSON round trip. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

/** A JSON object, used for payloads whose shape another system defines. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Returns true when the value is a plain JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-copies a value into JSON, dropping anything JSON cannot represent.
 *
 * This is how a class instance becomes a plain data object, and it guarantees
 * the caller's value is never mutated downstream. A member of an array that
 * JSON cannot represent becomes `null`, which is what `JSON.stringify` does.
 *
 * @throws TypeError When the value contains a cycle.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return undefined;
  }
  const parsed: JsonValue = JSON.parse(json);
  return parsed;
}

/**
 * Deep-copies an object into JSON, for a caller that needs a `JsonObject`
 * rather than a `JsonValue`. An object survives the round trip as an object,
 * unless its `toJSON` returns something else, as a `Date`'s does; there is
 * nothing to copy then, so the result is empty.
 */
export function toJsonObject(value: object): JsonObject {
  const parsed = toJsonValue(value);
  return isJsonObject(parsed) ? parsed : {};
}

/**
 * Serializes a value to JSON, falling back to its string form when JSON cannot
 * represent it (a circular structure, a `BigInt`).
 */
export function toJsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
