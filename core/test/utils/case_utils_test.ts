/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {camelCaseKeys, toSnakeCase} from '../../src/utils/case_utils.js';

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

  describe('toSnakeCase', () => {
    it('should split lowerCamelCase', () => {
      expect(toSnakeCase('camelCase')).toBe('camel_case');
      expect(toSnakeCase('emptyDescTest')).toBe('empty_desc_test');
    });

    it('should split UpperCamelCase', () => {
      expect(toSnakeCase('UpperCamelCase')).toBe('upper_camel_case');
    });

    it('should split a digit from the word that follows it', () => {
      expect(toSnakeCase('oauth2Client')).toBe('oauth2_client');
    });

    it('should keep an acronym together and split the word after it', () => {
      expect(toSnakeCase('RESTClient')).toBe('rest_client');
      expect(toSnakeCase('Mock API')).toBe('mock_api');
      expect(toSnakeCase('Empty Description API')).toBe(
        'empty_description_api',
      );
    });

    it('should replace runs of non-alphanumeric characters with one underscore', () => {
      expect(toSnakeCase('space separated')).toBe('space_separated');
      expect(toSnakeCase('dash-and.dot')).toBe('dash_and_dot');
      expect(toSnakeCase('many   spaces')).toBe('many_spaces');
    });

    it('should trim leading and trailing underscores', () => {
      expect(toSnakeCase('__wrapped__')).toBe('wrapped');
      expect(toSnakeCase('  padded  ')).toBe('padded');
    });

    it('should leave a snake_case string unchanged', () => {
      expect(toSnakeCase('already_snake_case')).toBe('already_snake_case');
    });

    it('should return an empty string when nothing survives', () => {
      expect(toSnakeCase('')).toBe('');
      expect(toSnakeCase('---')).toBe('');
    });
  });
});
