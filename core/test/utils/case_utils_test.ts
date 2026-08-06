/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {camelCaseKeys, snakeCase} from '../../src/utils/case_utils.js';

describe('case_utils', () => {
  describe('snakeCase', () => {
    it.each([
      ['camelCase', 'camel_case'],
      ['UpperCamelCase', 'upper_camel_case'],
      ['space separated', 'space_separated'],
      ['Mock API', 'mock_api'],
      ['REST API', 'rest_api'],
      ['Empty Description API', 'empty_description_api'],
      ['  weird--punctuation!!  ', 'weird_punctuation'],
      ['', ''],
    ])('should convert %o to %o', (input, expected) => {
      expect(snakeCase(input)).toBe(expected);
    });
  });

  // Transcribed from adk-python's TestToSnakeCase parametrized table in
  // tests/unittests/tools/test_gemini_schema_util.py. adk-js names OpenAPI
  // tools and tool arguments with snakeCase, so every row here is the
  // reference output, including the counter-intuitive ones.
  describe('snakeCase parity with adk-python _to_snake_case', () => {
    it.each([
      ['lowerCamelCase', 'lower_camel_case'],
      ['UpperCamelCase', 'upper_camel_case'],
      ['space separated', 'space_separated'],
      ['REST API', 'rest_api'],
      ['Mixed_CASE with_Spaces', 'mixed_case_with_spaces'],
      ['__init__', 'init'],
      ['APIKey', 'api_key'],
      ['SomeLongURL', 'some_long_url'],
      ['CONSTANT_CASE', 'constant_case'],
      ['already_snake_case', 'already_snake_case'],
      ['single', 'single'],
      ['', ''],
      ['  spaced  ', 'spaced'],
      ['with123numbers', 'with123numbers'],
      ['With_Mixed_123_and_SPACES', 'with_mixed_123_and_spaces'],
      ['HTMLParser', 'html_parser'],
      ['HTTPResponseCode', 'http_response_code'],
      ['a_b_c', 'a_b_c'],
      ['A_B_C', 'a_b_c'],
      ['fromAtoB', 'from_ato_b'],
      ['XMLHTTPRequest', 'xmlhttp_request'],
      ['_leading', 'leading'],
      ['trailing_', 'trailing'],
      ['  leading_and_trailing_  ', 'leading_and_trailing'],
      ['Multiple___Underscores', 'multiple_underscores'],
      ['  spaces_and___underscores  ', 'spaces_and_underscores'],
      ['  _mixed_Case  ', 'mixed_case'],
      ['123Start', '123_start'],
      ['End123', 'end123'],
      ['Mid123dle', 'mid123dle'],
    ])('should convert %o to %o', (input, expected) => {
      expect(snakeCase(input)).toBe(expected);
    });

    // Names taken from the OpenAPI specs that reported the naming bug.
    it.each([
      ['jira_list_Issues', 'jira_list_issues'],
      ['X-API-Key', 'x_api_key'],
      ['getPetByID', 'get_pet_by_id'],
      ['get__users__id_', 'get_users_id'],
    ])('should convert the OpenAPI name %o to %o', (input, expected) => {
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
