/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
