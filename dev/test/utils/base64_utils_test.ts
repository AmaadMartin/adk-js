/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  decodeBase64Utf8,
  parseJsonOrRaw,
} from '../../src/utils/base64_utils.js';

describe('decodeBase64Utf8', () => {
  it('decodes a clean payload', () => {
    expect(
      decodeBase64Utf8(Buffer.from('hello world').toString('base64')),
    ).toBe('hello world');
  });

  it('ignores characters outside the base64 alphabet', () => {
    expect(decodeBase64Utf8('SGVs bG8=')).toBe('Hello');
  });

  it('throws on incorrect padding', () => {
    expect(() => decodeBase64Utf8('!!!not-valid-base64!!!')).toThrow(
      'Incorrect padding',
    );
  });

  it('throws on bytes that are not valid UTF-8', () => {
    expect(() =>
      decodeBase64Utf8(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')),
    ).toThrow();
  });
});

describe('parseJsonOrRaw', () => {
  it('parses a JSON object', () => {
    expect(parseJsonOrRaw('{"a": 1}')).toEqual({a: 1});
  });

  it('parses a JSON scalar', () => {
    expect(parseJsonOrRaw('null')).toBeNull();
    expect(parseJsonOrRaw('0')).toBe(0);
  });

  it('keeps text that is not JSON', () => {
    expect(parseJsonOrRaw('summarise this')).toBe('summarise this');
    expect(parseJsonOrRaw('')).toBe('');
  });
});
