/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {camelCaseKeys, toSnakeCaseName} from '../../src/utils/case_utils.js';

describe('case_utils', () => {
  describe('toSnakeCaseName', () => {
    it('should split lowerCamelCase', () => {
      expect(toSnakeCaseName('camelCase')).toBe('camel_case');
    });

    it('should split UpperCamelCase', () => {
      expect(toSnakeCaseName('UpperCamelCase')).toBe('upper_camel_case');
    });

    it('should replace a space', () => {
      expect(toSnakeCaseName('space separated')).toBe('space_separated');
    });

    it('should keep an acronym whole', () => {
      expect(toSnakeCaseName('REST API')).toBe('rest_api');
    });

    it('should replace the punctuation in a header name', () => {
      expect(toSnakeCaseName('X-Trace-Id')).toBe('x_trace_id');
    });

    it('should split an acronym from the word after it', () => {
      expect(toSnakeCaseName('HTTPResponse')).toBe('http_response');
    });

    it('should collapse repeated and trailing separators', () => {
      expect(toSnakeCaseName('get__users__id_')).toBe('get_users_id');
    });

    it('should return an empty string for an empty name', () => {
      expect(toSnakeCaseName('')).toBe('');
    });

    it('should return an empty string for punctuation alone', () => {
      expect(toSnakeCaseName('---')).toBe('');
    });
  });

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
});
