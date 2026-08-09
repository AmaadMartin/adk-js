/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  canonicalJson,
  sha256Hex,
  stableDigest,
} from '../../src/utils/hash_utils.js';

describe('hash_utils', () => {
  describe('sha256Hex', () => {
    // Published FIPS 180-4 vectors. The 56-byte and 112-byte inputs are the
    // lengths that no longer leave room for the length suffix, so they force
    // the second padding block.
    it.each([
      {
        bytes: 0,
        input: '',
        digest:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        bytes: 3,
        input: 'abc',
        digest:
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
      {
        bytes: 56,
        input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        digest:
          '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      },
      {
        bytes: 112,
        input:
          'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
          'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        digest:
          'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
      },
    ])(
      'digests the $bytes-byte FIPS 180-4 vector',
      ({bytes, input, digest}) => {
        expect(input).toHaveLength(bytes);
        expect(sha256Hex(input)).toBe(digest);
      },
    );

    it('digests one million repetitions of "a"', () => {
      expect(sha256Hex('a'.repeat(1000000))).toBe(
        'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
      );
    });

    it('digests the UTF-8 bytes rather than the characters', () => {
      // 'héllo' is six UTF-8 bytes and five characters, so an implementation
      // that hashed char codes would read a different message.
      expect(sha256Hex('héllo')).toBe(
        '3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179',
      );
      expect(sha256Hex('héllo')).not.toBe(sha256Hex('hello'));
    });
  });

  describe('canonicalJson', () => {
    it('ignores property insertion order', () => {
      expect(canonicalJson({b: 1, a: 2})).toBe('{"a":2,"b":1}');
      expect(canonicalJson({a: 2, b: 1})).toBe('{"a":2,"b":1}');
    });

    it('drops undefined and null members at every depth', () => {
      expect(
        canonicalJson({a: 1, b: undefined, c: null, d: {e: null, f: 2}}),
      ).toBe('{"a":1,"d":{"f":2}}');
    });

    it('preserves array order and sorts objects inside arrays', () => {
      expect(canonicalJson([{b: 1, a: 2}, 3, 'x'])).toBe(
        '[{"a":2,"b":1},3,"x"]',
      );
    });

    it('serialises an undefined array element as null', () => {
      expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
    });

    it('emits non-ASCII characters literally', () => {
      expect(canonicalJson({k: 'héllo'})).toBe('{"k":"héllo"}');
    });

    it.each([
      [null, 'null'],
      [undefined, 'null'],
      [5, '5'],
      [true, 'true'],
      ['x', '"x"'],
      [{}, '{}'],
      [[], '[]'],
    ])('serialises %j as %s', (value, expected) => {
      expect(canonicalJson(value)).toBe(expected);
    });
  });

  describe('stableDigest', () => {
    it('returns 16 lowercase hex characters', () => {
      expect(stableDigest({a: 1})).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is equal for two key-order-permuted twins', () => {
      expect(stableDigest({a: 1, b: {c: 2, d: 3}})).toBe(
        stableDigest({b: {d: 3, c: 2}, a: 1}),
      );
    });

    it('differs when one nested value differs', () => {
      expect(stableDigest({a: 1, b: {c: 2}})).not.toBe(
        stableDigest({a: 1, b: {c: 3}}),
      );
    });
  });
});
