/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {snakeToLowerCamel} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {camelCaseKeys} from '../../src/utils/case_utils.js';

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

  describe('snakeToLowerCamel', () => {
    it('should return a single word unchanged', () => {
      expect(snakeToLowerCamel('single')).toBe('single');
    });

    it('should join two words', () => {
      expect(snakeToLowerCamel('two_words')).toBe('twoWords');
    });

    it('should join three words', () => {
      expect(snakeToLowerCamel('three_word_example')).toBe('threeWordExample');
    });

    it('should return an empty string unchanged', () => {
      expect(snakeToLowerCamel('')).toBe('');
    });

    it('should return an already camelCase name unchanged', () => {
      expect(snakeToLowerCamel('alreadyCamelCase')).toBe('alreadyCamelCase');
    });

    it('should lowercase every segment before joining', () => {
      expect(snakeToLowerCamel('TWO_WORDS')).toBe('twoWords');
    });

    it('should tolerate a trailing underscore', () => {
      expect(snakeToLowerCamel('trailing_')).toBe('trailing');
    });
  });
});
