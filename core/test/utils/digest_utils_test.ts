/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  canonicalJson,
  digestText,
  stableDigest,
} from '../../src/utils/digest_utils.js';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({b: 2, a: 1})).toBe('{"a":1,"b":2}');
  });

  it('sorts the keys of a nested object', () => {
    expect(canonicalJson({outer: {z: 1, a: {y: 2, b: 3}}})).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it('drops object entries holding undefined or null', () => {
    expect(canonicalJson({a: 1, b: undefined, c: null})).toBe('{"a":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
  });

  it('keeps a null array element, which carries a position', () => {
    expect(canonicalJson([1, null, 2])).toBe('[1,null,2]');
  });

  it('serializes primitives', () => {
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('throws on a circular reference instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/circular reference/);
  });

  it('throws on a circular reference reached through an array', () => {
    const items: unknown[] = [];
    items.push(items);

    expect(() => canonicalJson(items)).toThrow(/circular reference/);
  });

  it('accepts the same object twice when it is not an ancestor', () => {
    const shared = {a: 1};

    expect(canonicalJson({left: shared, right: shared})).toBe(
      '{"left":{"a":1},"right":{"a":1}}',
    );
  });
});

describe('stableDigest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 16 hex characters', async () => {
    expect(await stableDigest({a: 1})).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the same digest for the same value', async () => {
    expect(await stableDigest({a: 1, b: [1, 2]})).toBe(
      await stableDigest({a: 1, b: [1, 2]}),
    );
  });

  it('ignores key order', async () => {
    expect(await stableDigest({a: 1, b: 2})).toBe(
      await stableDigest({b: 2, a: 1}),
    );
  });

  it('changes when a value changes', async () => {
    expect(await stableDigest({a: 1})).not.toBe(await stableDigest({a: 2}));
  });

  it('reports a missing Web Crypto API rather than degrading', async () => {
    vi.stubGlobal('crypto', undefined);

    await expect(stableDigest({a: 1})).rejects.toThrow(/Web Crypto API/);
  });

  it('digests the canonical form of the value', async () => {
    expect(await stableDigest({b: 2, a: 1})).toBe(
      await digestText(canonicalJson({b: 2, a: 1})),
    );
  });
});

describe('digestText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 16 hex characters', async () => {
    expect(await digestText('text')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the same digest for the same text', async () => {
    expect(await digestText('text')).toBe(await digestText('text'));
  });

  it('changes when the text changes', async () => {
    expect(await digestText('text')).not.toBe(await digestText('other'));
  });

  it('reports a missing Web Crypto API rather than degrading', async () => {
    vi.stubGlobal('crypto', undefined);

    await expect(digestText('text')).rejects.toThrow(/Web Crypto API/);
  });
});
