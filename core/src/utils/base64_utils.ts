/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Standard base64 alphabet, with optional padding. */
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** URL-safe base64 alphabet, with optional padding. */
const URL_SAFE_BASE64 = /^[A-Za-z0-9\-_]*={0,2}$/;

/**
 * Decodes a string that is base64, in either the standard or the URL-safe
 * alphabet, and returns `undefined` when the string is not base64 at all.
 *
 * `Buffer.from(value, 'base64')` cannot be used on its own for this: it never
 * throws and silently discards every character outside the alphabet, so plain
 * text decodes to arbitrary bytes instead of being rejected. Callers that hold
 * a string which is *either* base64 *or* literal text need that distinction.
 *
 * @param data The string to decode.
 * @return The decoded bytes, or `undefined` when `data` is not base64.
 */
export function maybeBase64ToBytes(data: string): Buffer | undefined {
  if (data.length % 4 !== 0) {
    return undefined;
  }
  if (STANDARD_BASE64.test(data)) {
    return Buffer.from(data, 'base64');
  }
  if (URL_SAFE_BASE64.test(data)) {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  return undefined;
}
