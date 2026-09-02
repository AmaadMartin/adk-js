/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stableJsonStringify} from '../../src/utils/json_utils.js';

describe('stableJsonStringify', () => {
  it('sorts the top-level keys whatever their insertion order', () => {
    expect(stableJsonStringify({product: 'shoes', brand: 'Nike'})).toBe(
      '{"brand":"Nike","product":"shoes"}',
    );
    expect(stableJsonStringify({brand: 'Nike', product: 'shoes'})).toBe(
      '{"brand":"Nike","product":"shoes"}',
    );
  });

  it('sorts the keys of a nested object', () => {
    expect(stableJsonStringify({outer: {b: 2, a: 1}})).toBe(
      '{"outer":{"a":1,"b":2}}',
    );
  });

  it('sorts the keys of an object nested inside an array', () => {
    expect(stableJsonStringify({items: [{b: 2, a: 1}]})).toBe(
      '{"items":[{"a":1,"b":2}]}',
    );
  });

  it('preserves the order of array elements', () => {
    expect(stableJsonStringify({list: [3, 1, 2]})).toBe('{"list":[3,1,2]}');
  });

  it('keeps non-ASCII characters literal', () => {
    expect(stableJsonStringify({greeting: 'héllo 😀'})).toBe(
      '{"greeting":"héllo 😀"}',
    );
  });

  it('serializes an empty object, null and a primitive', () => {
    expect(stableJsonStringify({})).toBe('{}');
    expect(stableJsonStringify(null)).toBe('null');
    expect(stableJsonStringify({value: null})).toBe('{"value":null}');
    expect(stableJsonStringify(7)).toBe('7');
    expect(stableJsonStringify('text')).toBe('"text"');
  });
});
