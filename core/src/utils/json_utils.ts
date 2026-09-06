/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from './error_utils.js';

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

/**
 * Readers for decoded JSON, used wherever this package inspects a value that
 * came off the wire and therefore has no compile-time shape.
 */

/**
 * Narrows an arbitrary value to a plain JSON object, or `undefined` when it is
 * not one.
 */
export function asJsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field, returning `''` when it is absent or not a string. */
export function readString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** The stand-in written in place of a value that refers back to itself. */
const CIRCULAR_STAND_IN = '[Circular]';

/** Notified once for each value that was replaced. */
type ReplaceListener = () => void;

/**
 * Converts a value into a form `JSON.stringify` can represent.
 *
 * Functions, symbols, bigints and circular references are replaced with a
 * string stand-in instead of throwing or being dropped, so a structure that
 * holds one can still be persisted. An object with a `toJSON` method (a `Date`,
 * for example) is converted through that method, so rich types keep a faithful
 * representation rather than becoming `{}`.
 *
 * @param value The value to convert.
 * @param onReplace Called once for every value that was replaced.
 * @returns A value that `JSON.stringify` accepts.
 */
export function toJsonSerializable(
  value: unknown,
  onReplace?: ReplaceListener,
): unknown {
  return convert(value, new Set<object>(), onReplace);
}

function convert(
  value: unknown,
  visiting: Set<object>,
  onReplace?: ReplaceListener,
): unknown {
  const standIn = jsonStandIn(value);
  if (standIn !== undefined) {
    onReplace?.();
    return standIn;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (visiting.has(value)) {
    onReplace?.();
    return CIRCULAR_STAND_IN;
  }

  visiting.add(value);
  const converted = convertObject(value, visiting, onReplace);
  visiting.delete(value);
  return converted;
}

function convertObject(
  value: object,
  visiting: Set<object>,
  onReplace?: ReplaceListener,
): unknown {
  if (hasToJson(value)) {
    return convert(value.toJSON(), visiting, onReplace);
  }
  if (Array.isArray(value)) {
    return value.map((item) => convert(item, visiting, onReplace));
  }

  const converted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // `JSON.stringify` omits an undefined property; keep that shape.
    if (item !== undefined) {
      converted[key] = convert(item, visiting, onReplace);
    }
  }
  return converted;
}

function jsonStandIn(value: unknown): string | undefined {
  switch (typeof value) {
    case 'function':
      return `[Function: ${value.name || 'anonymous'}]`;
    case 'symbol':
      return String(value);
    case 'bigint':
      return value.toString();
    default:
      return undefined;
  }
}

function hasToJson(value: object): value is {toJSON: () => unknown} {
  return 'toJSON' in value && typeof value.toJSON === 'function';
}

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

/**
 * Parses JSON, raising a uniform error on malformed input.
 *
 * Wraps `JSON.parse` so callers get one error type and one message shape
 * instead of a bare `SyntaxError` that says nothing about where the text came
 * from.
 *
 * @param text The JSON text to parse.
 * @param context Human-readable label for where `text` came from, for example
 *   `'session state'`. It is included in the error message.
 * @return The parsed value.
 * @throws If `text` is not valid JSON.
 */
export function safeJsonLoads(text: string, context?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    const suffix = context ? ` in ${context}` : '';
    throw new Error(`Invalid JSON${suffix}: ${formatError(err)}`, {cause: err});
  }
}

/** Narrows a decoded JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Written wherever a value cannot be represented. */
export const NOT_SERIALIZABLE = '<not serializable>';

/**
 * Serializes a value to compact JSON, or to {@link NOT_SERIALIZABLE}.
 *
 * `JSON.stringify` produces no whitespace and does not escape non-ASCII, which
 * matches the compact form the OpenTelemetry attribute values use. It throws on
 * a cycle or a `BigInt`, and returns `undefined` for a value it drops, such as
 * `undefined` itself or a function.
 */
export function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? NOT_SERIALIZABLE;
  } catch {
    return NOT_SERIALIZABLE;
  }
}

/** Matches the opening fence of a Markdown code block, with its language tag. */
const OPENING_CODE_FENCE = /^```[a-zA-Z]*\n/;

/** Matches the closing fence of a Markdown code block. */
const CLOSING_CODE_FENCE = /\n```$/;

/**
 * Parses JSON a model produced, tolerating a Markdown code fence around it.
 *
 * A model asked for raw JSON often answers with the document wrapped in
 * ```` ```json ```` … ```` ``` ````. The fence is formatting, not data, so it is
 * removed before parsing.
 *
 * @param text The raw text the model produced.
 * @returns The parsed value, or `undefined` when `text` is not valid JSON.
 *     `undefined` is unambiguous here, because JSON cannot encode it.
 */
export function parseFencedJson(text: string): unknown {
  const withoutFence = text
    .trim()
    .replace(OPENING_CODE_FENCE, '')
    .replace(CLOSING_CODE_FENCE, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    return undefined;
  }
}

/**
 * Reads one own property of a value that may not be an object at all.
 *
 * Own properties only, so a key inherited from the prototype chain — `toString`
 * on any object literal — never reads as data the server sent.
 */
export function readOwn(value: unknown, key: string): unknown {
  return value === null || typeof value !== 'object'
    ? undefined
    : Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * Reads one own property as a string, or `undefined` when it is anything else.
 *
 * A server is free to answer with a number, `null` or an array where the caller
 * expects text. Returning `undefined` for those lets the caller take the same
 * path it takes for an absent field, instead of calling a string method on
 * whatever arrived. {@link readString} is the counterpart for a caller that
 * holds a record already and wants `''` for a field that is missing.
 */
export function readOwnString(value: unknown, key: string): string | undefined {
  const property = readOwn(value, key);
  return typeof property === 'string' ? property : undefined;
}
