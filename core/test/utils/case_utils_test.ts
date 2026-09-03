/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  camelCaseKeys,
  camelCaseTopLevelKeys,
} from '../../src/utils/case_utils.js';

describe('case_utils', () => {
  describe('camelCaseKeys', () => {
    it('should convert simple object keys', () => {
      const input = {
        'foo_bar': 'value',
        'baz': 123,
      };
      const expected = {
        fooBar: 'value',
        baz: 123,
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should convert nested object keys', () => {
      const input = {
        'foo_bar': {
          'nested_key': 'value',
          'another_nested': {
            'deep_key': true,
          },
        },
      };
      const expected = {
        fooBar: {
          nestedKey: 'value',
          anotherNested: {
            deepKey: true,
          },
        },
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should convert objects inside arrays', () => {
      const input = [
        {
          'foo_bar': 'val1',
        },
        {
          'baz_qux': [
            {
              'nested_array_key': 'val2',
            },
          ],
        },
      ];
      const expected = [
        {
          fooBar: 'val1',
        },
        {
          bazQux: [
            {
              nestedArrayKey: 'val2',
            },
          ],
        },
      ];
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should not modify non-plain objects', () => {
      const date = new Date();
      const input = {
        'date_field': date,
      };
      const expected = {
        dateField: date,
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should handle null and undefined', () => {
      expect(camelCaseKeys(null)).toBeNull();
      expect(camelCaseKeys(undefined)).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(camelCaseKeys(123)).toBe(123);
      expect(camelCaseKeys('hello')).toBe('hello');
      expect(camelCaseKeys(true)).toBe(true);
    });
  });

  describe('camelCaseTopLevelKeys', () => {
    it('converts the object own keys', () => {
      expect(camelCaseTopLevelKeys({'foo_bar': 'value', 'baz': 123})).toEqual({
        fooBar: 'value',
        baz: 123,
      });
    });

    it('leaves the keys of a nested object alone', () => {
      const input = {'tool_args': {'corpus_id': 'docs-prod'}};

      expect(camelCaseTopLevelKeys(input)).toEqual({
        toolArgs: {'corpus_id': 'docs-prod'},
      });
    });

    it('leaves the objects inside an array alone', () => {
      const input = {'tool_list': [{'nested_key': 'value'}]};

      expect(camelCaseTopLevelKeys(input)).toEqual({
        toolList: [{'nested_key': 'value'}],
      });
    });

    it('returns a non-plain object unchanged', () => {
      const date = new Date();

      expect(camelCaseTopLevelKeys(date)).toBe(date);
      expect(camelCaseTopLevelKeys([{'foo_bar': 1}])).toEqual([{'foo_bar': 1}]);
    });

    it('returns null, undefined and primitives unchanged', () => {
      expect(camelCaseTopLevelKeys(null)).toBeNull();
      expect(camelCaseTopLevelKeys(undefined)).toBeUndefined();
      expect(camelCaseTopLevelKeys('hello')).toBe('hello');
    });
  });
});
