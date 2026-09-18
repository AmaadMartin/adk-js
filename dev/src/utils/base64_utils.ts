/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';

/** Every character that is not a base64 digit or a padding character. */
const NON_BASE64_CHARACTERS = /[^A-Za-z0-9+/=]/g;

/** A base64 payload is a whole number of 4-character groups. */
const BASE64_GROUP_LENGTH = 4;

/**
 * Decodes a base64 payload to text, and throws when the payload is not
 * decodable.
 *
 * Characters outside the base64 alphabet are discarded before the length is
 * checked, and the decoded bytes must be valid UTF-8. `Buffer.from(x,
 * 'base64')` alone does neither: it accepts any input and substitutes U+FFFD
 * for undecodable bytes, so a caller cannot tell a real payload from junk.
 *
 * @param encoded The base64 text to decode.
 * @return The decoded UTF-8 text.
 * @throws Error When the padding is wrong or the bytes are not valid UTF-8.
 */
export function decodeBase64Utf8(encoded: string): string {
  const digits = encoded.replace(NON_BASE64_CHARACTERS, '');
  if (digits.length % BASE64_GROUP_LENGTH !== 0) {
    throw new Error(
      `Incorrect base64 padding: ${digits.length} characters is not a ` +
        `multiple of ${BASE64_GROUP_LENGTH}.`,
    );
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(
    Buffer.from(digits, 'base64'),
  );
}

/**
 * Parses `text` as JSON, and returns `text` unchanged when it is not JSON.
 *
 * Event payloads are frequently JSON but are not required to be, so a plain
 * string body is forwarded to the agent as-is rather than rejected.
 */
export function parseJsonOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
