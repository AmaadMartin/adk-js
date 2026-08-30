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
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Returns a short, stable SHA-256 digest of a JSON-like value.
 *
 * The digest is computed over {@link canonicalJson}, so it does not depend on
 * key insertion order. It is a process-independent identifier, not a wire
 * contract: nothing outside this repository reads it.
 *
 * Web Crypto is used rather than `node:crypto` because this module reaches the
 * browser bundle, where `node:crypto` is aliased to a shim.
 *
 * @param value The value to digest.
 * @returns The first {@link DIGEST_LENGTH} hex characters of the digest.
 * @throws Error If the Web Crypto API is unavailable.
 */
export async function stableDigest(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'stableDigest: the Web Crypto API (globalThis.crypto.subtle) is not ' +
        'available in this environment.',
    );
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, DIGEST_LENGTH);
}
