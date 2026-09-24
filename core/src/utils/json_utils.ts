/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Helpers for reading a parsed JSON body whose shape nothing guarantees. */

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
 * whatever arrived.
 */
export function readString(value: unknown, key: string): string | undefined {
  const property = readOwn(value, key);
  return typeof property === 'string' ? property : undefined;
}
