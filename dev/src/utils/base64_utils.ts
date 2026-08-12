/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Helpers for decoding an encoded payload that arrived over the wire. */

/** Characters outside the base64 alphabet, which are discarded before decoding. */
const NON_BASE64_PATTERN = /[^A-Za-z0-9+/=]/g;

/**
 * Decodes a base64 string strictly: incorrect padding and invalid UTF-8 both
 * throw, where `Buffer.from(data, 'base64')` accepts either and yields
 * plausible nonsense. Characters outside the base64 alphabet are discarded
 * first, so a value wrapped across lines still decodes.
 *
 * @param data The base64-encoded string.
 * @return The decoded UTF-8 text.
 * @throws When the padding is wrong or the bytes are not valid UTF-8.
 */
export function decodeBase64Utf8(data: string): string {
  const normalized = data.replace(NON_BASE64_PATTERN, '');
  if (normalized.length % 4 !== 0) {
    throw new Error('Incorrect padding');
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(
    Buffer.from(normalized, 'base64'),
  );
}

/** Parses `text` as JSON, keeping the raw string when it is not JSON. */
export function parseJsonOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
