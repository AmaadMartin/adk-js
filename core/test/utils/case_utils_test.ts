/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {camelCaseKeys, snakeCase} from '../../src/utils/case_utils.js';

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

  describe('snakeCase', () => {
    it('should split lowerCamelCase', () => {
      expect(snakeCase('camelCase')).toBe('camel_case');
    });

    it('should split UpperCamelCase', () => {
      expect(snakeCase('UpperCamelCase')).toBe('upper_camel_case');
    });

    it('should replace spaces', () => {
      expect(snakeCase('space separated')).toBe('space_separated');
    });

    it('should split an acronym from the word that follows it', () => {
      expect(snakeCase('REST API')).toBe('rest_api');
      expect(snakeCase('RESTApi')).toBe('rest_api');
    });

    it('should convert the spec titles the toolset derives its name from', () => {
      expect(snakeCase('Mock API')).toBe('mock_api');
      expect(snakeCase('Empty Description API')).toBe('empty_description_api');
    });

    it('should collapse and trim runs of separators', () => {
      expect(snakeCase('!!weird--input!!')).toBe('weird_input');
    });

    it('should return an empty string for an empty input', () => {
      expect(snakeCase('')).toBe('');
    });
  });
});
