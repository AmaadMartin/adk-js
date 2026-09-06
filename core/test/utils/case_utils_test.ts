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
      ['REST API', 'rest_api'],
      ['getHTTPResponse', 'get_http_response'],
      ['already_snake', 'already_snake'],
    ])('should convert %s to %s', (input, expected) => {
      expect(snakeCase(input)).toBe(expected);
    });

    it.each([
      ['/test_get', 'test_get'],
      ['/users/{id}_get', 'users_id_get'],
      ['/pets/{petId}_get', 'pets_pet_id_get'],
      ['/Orders/{orderId}/lineItems_patch', 'orders_order_id_line_items_patch'],
      ['/v1/REST API/items_post', 'v1_rest_api_items_post'],
      ['/a--b/_delete', 'a_b_delete'],
    ])('should name the operation %s the way adk-python does', (path, name) => {
      expect(snakeCase(path)).toBe(name);
    });

    it('should return an empty string when nothing alphanumeric remains', () => {
      expect(snakeCase('___')).toBe('');
      expect(snakeCase('')).toBe('');
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
