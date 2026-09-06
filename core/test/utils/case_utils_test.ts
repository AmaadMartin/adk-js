/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {camelCaseKeys, snakeCase} from '../../src/utils/case_utils.js';

describe('case_utils', () => {
  describe('snakeCase', () => {
    // Every expectation below is the output of `_to_snake_case` in adk-python
    // (src/google/adk/tools/_gemini_schema_util.py) for the same input.
    it.each([
      ['camelCase', 'camel_case'],
      ['UpperCamelCase', 'upper_camel_case'],
      ['space separated', 'space_separated'],
      ['REST API', 'rest_api'],
      ['HTTPResponseCode', 'http_response_code'],
      ['already_snake_case', 'already_snake_case'],
      ['Multiple___Underscores', 'multiple_underscores'],
      ['  _leading_and_trailing_  ', 'leading_and_trailing'],
      ['X-API-Key', 'x_api_key'],
      ['123Start', '123_start'],
      ['', ''],
    ])('should convert %j to %j', (input, expected) => {
      expect(snakeCase(input)).toBe(expected);
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
