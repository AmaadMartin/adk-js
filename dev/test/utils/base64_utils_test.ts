/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';
import {describe, expect, it} from 'vitest';

import {
  decodeBase64Utf8,
  parseJsonOrRaw,
} from '../../src/utils/base64_utils.js';

describe('decodeBase64Utf8', () => {
  it('decodes a well-formed base64 payload', () => {
    expect(decodeBase64Utf8(Buffer.from('Hello').toString('base64'))).toBe(
      'Hello',
    );
  });

  it('decodes an empty payload to an empty string', () => {
    expect(decodeBase64Utf8('')).toBe('');
  });

  it('discards characters outside the base64 alphabet before decoding', () => {
    // CPython's base64.b64decode(validate=False) strips them too, so
    // 'SG!!Vsb!!G8=' decodes to 'Hello' on both sides.
    expect(decodeBase64Utf8('SG!!Vsb!!G8=')).toBe('Hello');
  });

  it('throws when the surviving characters are not a whole group', () => {
    // '!!!not-valid-base64!!!' reduces to 14 base64 digits, which is not a
    // multiple of 4. CPython raises "Incorrect padding" for the same input.
    expect(() => decodeBase64Utf8('!!!not-valid-base64!!!')).toThrow(
      /Incorrect base64 padding: 14 characters/,
    );
  });

  it('throws when the decoded bytes are not valid UTF-8', () => {
    // 'abcd' decodes to 0x69 0xb7 0x1d. Buffer.toString('utf8') would
    // substitute U+FFFD and hide the failure.
    expect(() => decodeBase64Utf8('abcd')).toThrow();
  });

  it('accepts multi-byte UTF-8 text', () => {
    const encoded = Buffer.from('héllo wörld ✓', 'utf-8').toString('base64');
    expect(decodeBase64Utf8(encoded)).toBe('héllo wörld ✓');
  });
});

describe('parseJsonOrRaw', () => {
  it('returns the parsed value for JSON text', () => {
    expect(parseJsonOrRaw('{"orderId": 42}')).toEqual({orderId: 42});
  });

  it('returns the original text when it is not JSON', () => {
    expect(parseJsonOrRaw('Hello from Pub/Sub')).toBe('Hello from Pub/Sub');
  });

  it('returns the original text for an empty string', () => {
    expect(parseJsonOrRaw('')).toBe('');
  });
});
