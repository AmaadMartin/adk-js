/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Hex characters kept from the SHA-256 output. */
const DIGEST_LENGTH = 16;

/**
 * Serializes a JSON-like value so that two structurally equal values always
 * produce the same string.
 *
 * Object keys are sorted, object entries holding `undefined` or `null` are
 * dropped, and no whitespace is emitted. Array order is preserved, because an
 * array is ordered data rather than a set.
 *
 * @param value The value to serialize. Objects, arrays, strings, numbers and
 *     booleans are supported; a value that `JSON.stringify` cannot represent
 *     is written as `null`.
 * @returns The canonical JSON text.
 * @throws Error If the value contains a circular reference.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (ancestors.has(value)) {
    throw new Error(
      'canonicalJson: the value contains a circular reference and cannot be ' +
        'serialized.',
    );
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? encodeArray(value, ancestors)
      : encodeObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function encodeArray(value: unknown[], ancestors: Set<object>): string {
  return `[${value.map((item) => encode(item, ancestors)).join(',')}]`;
}

function encodeObject(value: object, ancestors: Set<object>): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, ancestors)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Returns a short SHA-256 digest of a text.
 *
 * Web Crypto is used rather than `node:crypto` because this module reaches the
 * browser bundle, where `node:crypto` is aliased to a shim.
 *
 * @param text The text to digest.
 * @returns The first {@link DIGEST_LENGTH} hex characters of the digest.
 * @throws Error If the Web Crypto API is unavailable.
 */
export async function digestText(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'digestText: the Web Crypto API (globalThis.crypto.subtle) is not ' +
        'available in this environment.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, DIGEST_LENGTH);
}

/**
 * Returns a short, stable SHA-256 digest of a JSON-like value.
 *
 * The digest is computed over {@link canonicalJson}, so it does not depend on
 * key insertion order. It is a process-independent identifier, not a wire
 * contract: nothing outside this repository reads it.
 *
 * @param value The value to digest.
 * @returns The first {@link DIGEST_LENGTH} hex characters of the digest.
 * @throws Error If the Web Crypto API is unavailable.
 */
export async function stableDigest(value: unknown): Promise<string> {
  return digestText(canonicalJson(value));
}
