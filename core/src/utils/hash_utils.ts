/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Round constants of SHA-256 (FIPS 180-4 section 4.2.2). */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value of SHA-256 (FIPS 180-4 section 5.3.3). */
const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;
/** Bytes reserved by the padding: one 0x80 marker plus a 64-bit length. */
const PADDING_BYTES = 9;
const DIGEST_HEX_LENGTH = 16;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Returns the SHA-256 digest of `text` as 64 lowercase hexadecimal characters.
 *
 * SHA-256 is written out here instead of imported because neither digest API
 * is usable from this package: `core/build.js` aliases `node:crypto` to a
 * browser shim that exports only `randomUUID`, and `crypto.subtle.digest` is
 * asynchronous and is exposed only in secure contexts. The implementation
 * stays within 32-bit integer arithmetic because the esbuild browser targets
 * in `core/build.js` reject BigInt literals.
 */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  const blocks =
    Math.floor((message.length + PADDING_BYTES - 1) / BLOCK_BYTES) + 1;
  const padded = new Uint8Array(blocks * BLOCK_BYTES);
  padded.set(message);
  padded[message.length] = 0x80;

  const bitLength = message.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength % 0x100000000);

  const hash = INITIAL_HASH.slice();
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i++) {
      schedule[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const x = schedule[i - 15];
      const y = schedule[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      schedule[i] = schedule[i - 16] + s0 + schedule[i - 7] + s1;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + ROUND_CONSTANTS[i] + schedule[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }

  let hex = '';
  for (const word of hash) {
    hex += word.toString(16).padStart(8, '0');
  }
  return hex;
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
 * Returns a short digest of `value` that is stable across processes and
 * across property insertion order.
 */
export function stableDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value)).slice(0, DIGEST_HEX_LENGTH);
}
