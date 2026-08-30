/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stableJsonStringify} from '../../src/utils/json_utils.js';

describe('json_utils', () => {
  describe('stableJsonStringify', () => {
    it('sorts top-level keys', () => {
      expect(stableJsonStringify({b: 1, a: 2})).toBe('{"a":2,"b":1}');
    });

    it('produces the same text whatever order the keys were inserted in', () => {
      expect(stableJsonStringify({b: 1, a: 2})).toBe(
        stableJsonStringify({a: 2, b: 1}),
      );
    });

    it('sorts nested keys recursively', () => {
      expect(stableJsonStringify({z: {d: 1, c: 2}})).toBe(
        '{"z":{"c":2,"d":1}}',
      );
    });

    it('keeps array element order', () => {
      expect(stableJsonStringify({a: [3, 1, 2]})).toBe('{"a":[3,1,2]}');
    });

    it('sorts the keys of objects inside arrays', () => {
      expect(stableJsonStringify({a: [{y: 1, x: 2}]})).toBe(
        '{"a":[{"x":2,"y":1}]}',
      );
    });

    it('passes primitives and null through', () => {
      expect(stableJsonStringify('text')).toBe('"text"');
      expect(stableJsonStringify(7)).toBe('7');
      expect(stableJsonStringify(true)).toBe('true');
      expect(stableJsonStringify(null)).toBe('null');
    });

    it('keeps a null member of an object', () => {
      expect(stableJsonStringify({b: null, a: 1})).toBe('{"a":1,"b":null}');
    });

    it('drops undefined members as JSON.stringify does', () => {
      expect(stableJsonStringify({b: undefined, a: 1})).toBe('{"a":1}');
    });

    it('serializes an empty object', () => {
      expect(stableJsonStringify({})).toBe('{}');
    });

    it('throws on cyclic input', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      expect(() => stableJsonStringify(cyclic)).toThrow(RangeError);
    });
  });
});
