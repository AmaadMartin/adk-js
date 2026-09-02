/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {stableJsonStringify} from '../../src/utils/json_utils.js';

describe('stableJsonStringify', () => {
  it('sorts the keys of a top-level object', () => {
    expect(stableJsonStringify({product: 'shoes', brand: 'Nike'})).toBe(
      '{"brand":"Nike","product":"shoes"}',
    );
  });

  it('produces the same text whatever the key order', () => {
    const inserted = stableJsonStringify({product: 'shoes', brand: 'Nike'});
    const reversed = stableJsonStringify({brand: 'Nike', product: 'shoes'});

    expect(inserted).toBe(reversed);
  });

  it('sorts the keys of a nested object', () => {
    expect(stableJsonStringify({outer: {b: 1, a: 2}})).toBe(
      '{"outer":{"a":2,"b":1}}',
    );
  });

  it('sorts the keys of an object inside an array', () => {
    expect(stableJsonStringify({list: [{b: 1, a: 2}]})).toBe(
      '{"list":[{"a":2,"b":1}]}',
    );
  });

  it('keeps array order, which is data rather than key order', () => {
    expect(stableJsonStringify({list: ['c', 'a', 'b']})).toBe(
      '{"list":["c","a","b"]}',
    );
  });

  it('leaves non-ASCII characters literal', () => {
    expect(stableJsonStringify({city: '東京'})).toBe('{"city":"東京"}');
  });

  it('omits an undefined property, the way JSON.stringify does', () => {
    expect(stableJsonStringify({b: undefined, a: 1})).toBe('{"a":1}');
  });

  it('serializes a null property rather than dropping it', () => {
    expect(stableJsonStringify({b: null, a: 1})).toBe('{"a":1,"b":null}');
  });

  it('serializes a bare value unchanged', () => {
    expect(stableJsonStringify('plain')).toBe('"plain"');
  });
});
