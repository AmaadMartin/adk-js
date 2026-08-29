/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
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
    // Two FNV-1a passes over the UTF-8 bytes of '{}', from offset bases
    // 2166136261 and 2654435761, are 0x5465b825 and 0xc95e7639.
    it('concatenates the two FNV-1a passes over the canonical JSON', () => {
      expect(stableDigest({})).toBe('5465b825c95e7639');
    });

    // The same two passes over the UTF-8 bytes of '{"k":"héllo"}' are
    // 0x99ca7735 and 0xc8326561. A char-oriented encoder would hash a
    // different message and produce a different digest.
    it('digests the UTF-8 bytes of a non-ASCII value', () => {
      expect(stableDigest({k: 'héllo'})).toBe('99ca7735c8326561');
    });

    it('returns sixteen lowercase hexadecimal characters', () => {
      expect(stableDigest({a: 1, b: [2, 3]})).toMatch(/^[0-9a-f]{16}$/);
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

    // The digest sits on the unconditional path of every authenticated
    // OpenAPI tool call, and reaches the browser bundle. `globalThis.crypto`
    // is absent on a default Node 18 and on a plain-HTTP browser origin, so a
    // digest that reads it takes that whole path down with a `TypeError`.
    it('digests with no Web Crypto global present', () => {
      vi.stubGlobal('crypto', undefined);
      try {
        expect(stableDigest({k: 'v'})).toMatch(/^[0-9a-f]{16}$/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('digests a null-prototype object as its plain twin', () => {
      const nullPrototype = Object.assign(Object.create(null), {b: 1, a: 2});

      expect(stableDigest(nullPrototype)).toBe(stableDigest({a: 2, b: 1}));
    });

    it('keeps a self-serialising value intact', () => {
      const date = new Date('2026-01-02T03:04:05.000Z');

      expect(canonicalJson({at: date})).toBe(
        '{"at":"2026-01-02T03:04:05.000Z"}',
      );
      expect(stableDigest({at: date})).toBe(
        stableDigest({at: '2026-01-02T03:04:05.000Z'}),
      );
    });
  });
});
