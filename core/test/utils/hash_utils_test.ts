/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {canonicalJson, stableDigest} from '../../src/utils/hash_utils.js';

describe('hash_utils', () => {
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
    // SHA-256('{}') is
    // 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a.
    it('returns the first eight bytes of the SHA-256 of the canonical JSON', async () => {
      expect(await stableDigest({})).toBe('44136fa355b3678a');
    });

    // SHA-256('{"k":"héllo"}') as UTF-8 is
    // d3352a192f21ed49ab7d14dbc8b24d71f95b178a227b9e2bbb6e10e584bbaa8f. A
    // char-oriented encoder would hash a different message.
    it('digests the UTF-8 bytes of a non-ASCII value', async () => {
      expect(await stableDigest({k: 'héllo'})).toBe('d3352a192f21ed49');
    });

    it('is equal for two key-order-permuted twins', async () => {
      expect(await stableDigest({a: 1, b: {c: 2, d: 3}})).toBe(
        await stableDigest({b: {d: 3, c: 2}, a: 1}),
      );
    });

    it('differs when one nested value differs', async () => {
      expect(await stableDigest({a: 1, b: {c: 2}})).not.toBe(
        await stableDigest({a: 1, b: {c: 3}}),
      );
    });
  });
});
