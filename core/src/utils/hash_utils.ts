/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Bytes of the SHA-256 digest that `stableDigest` keeps. */
const DIGEST_BYTES = 8;

/**
 * Returns a copy of `value` with object keys sorted and with `undefined` and
 * `null` members removed, so that structurally equal values serialise to the
 * same JSON.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    value.constructor === Object
  ) {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined || record[key] === null) {
        continue;
      }
      canonical[key] = canonicalize(record[key]);
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

/**
 * Returns a short SHA-256 digest of `value`, as lowercase hexadecimal. The
 * digest is stable across processes and across property insertion order.
 */
export async function stableDigest(value: unknown): Promise<string> {
  const message = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', message);
  return Array.from(new Uint8Array(digest, 0, DIGEST_BYTES))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
