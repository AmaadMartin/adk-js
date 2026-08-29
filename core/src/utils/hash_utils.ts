/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The FNV-1a 32-bit prime. */
const FNV_PRIME = 16777619;

/**
 * The offset bases the two digest passes start from. Every tool in a session
 * shares one key space, and a collision there serves one tool the credential
 * that belongs to another, so `stableDigest` runs two passes and concatenates
 * them for 64 bits rather than leaving a single 32-bit pass to collide.
 */
const FNV_OFFSET_BASES: readonly number[] = [2166136261, 2654435761];

/** Hexadecimal characters one 32-bit pass contributes to the digest. */
const HEX_CHARS_PER_PASS = 8;

/**
 * Reports whether `value` is an object whose keys `canonicalize` should sort.
 */
function isCanonicalisableRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  // A value that serialises itself, such as a `Date`, has to reach
  // `JSON.stringify` intact: sorting its own keys would discard the
  // representation it defines.
  return !('toJSON' in value);
}

/**
 * Returns a copy of `value` with object keys sorted and with `undefined` and
 * `null` members removed, so that structurally equal values serialise to the
 * same JSON.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isCanonicalisableRecord(value)) {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined || value[key] === null) {
        continue;
      }
      canonical[key] = canonicalize(value[key]);
    }
    return canonical;
  }
  return value;
}

/**
 * Serialises `value` to JSON that does not depend on property insertion order.
 *
 * Object keys are sorted, members that are `undefined` or `null` are dropped,
 * and array order is preserved. A top-level `undefined` serialises as `null`,
 * which is what `JSON.stringify` already does for an `undefined` array
 * element.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** Runs one FNV-1a pass over `bytes` and returns it as an unsigned 32-bit. */
function fnv1a(bytes: Uint8Array, offsetBasis: number): number {
  let hash = offsetBasis;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Returns a 16-character lowercase hexadecimal digest of `value`, stable
 * across processes and across property insertion order.
 *
 * This is NOT a cryptographic digest. It namespaces a cache key and nothing
 * more, so it must not be used for integrity, authentication, or any other
 * security decision.
 *
 * The hash is written out here because neither platform digest runs
 * everywhere this module does. `common.ts` re-exports it into the browser
 * bundle, and it sits on the unconditional path of every authenticated
 * OpenAPI tool call, so it has to work in both runtimes.
 *
 * `node:crypto` offers a synchronous `createHash`, but `build.js` aliases that
 * specifier to `crypto_shim.ts` for the web bundle, and the shim exports only
 * a `randomUUID` that throws. Importing `createHash` breaks that build.
 *
 * `crypto.subtle` is asynchronous, needs a secure context, and hangs off a
 * `globalThis.crypto` that stayed behind a flag until Node v19, so it throws a
 * `TypeError` on a default Node 18 and on a plain-HTTP browser origin.
 */
export function stableDigest(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return FNV_OFFSET_BASES.map((basis) =>
    fnv1a(bytes, basis).toString(16).padStart(HEX_CHARS_PER_PASS, '0'),
  ).join('');
}
