/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  toCamelCase,
  toSnakeCase,
} from '../../src/utils/object_notation_utils.js';

describe('toCamelCase', () => {
  it('converts snake_case to camelCase', () => {
    const obj = {snake_case: 'value', another_key: 'another_value'};

    expect(toCamelCase(obj)).toEqual({
      snakeCase: 'value',
      anotherKey: 'another_value',
    });
  });

  it('preserves keys when specified', () => {
    const obj = {
      snake_case: {another_snake_case: 'value'},
      another_key: 'another_value',
    };

    expect(toCamelCase(obj, ['snake_case'])).toEqual({
      snakeCase: {another_snake_case: 'value'},
      anotherKey: 'another_value',
    });
  });

  it('handles nested objects', () => {
    const obj = {snake_case: {nested_key: 'nested_value'}};

    expect(toCamelCase(obj)).toEqual({snakeCase: {nestedKey: 'nested_value'}});
  });

  it('handles arrays', () => {
    const obj = {snake_case: [{nested_key: 'nested_value'}]};

    expect(toCamelCase(obj)).toEqual({
      snakeCase: [{nestedKey: 'nested_value'}],
    });
  });

  it('handles top-level arrays', () => {
    const obj = [{snake_case: 'value'}];
    expect(toCamelCase(obj)).toEqual([{snakeCase: 'value'}]);
  });

  it('preserves keys using dot notation', () => {
    const obj = {
      snake_case: {
        nested_key: {
          nested_nested_key: 'value',
        },
        another_nested: 'value',
      },
    };
    expect(toCamelCase(obj, ['snake_case.nested_key'])).toEqual({
      snakeCase: {
        nestedKey: {
          nested_nested_key: 'value',
        },
        anotherNested: 'value',
      },
    });
  });

  it('handles primitives', () => {
    expect(toCamelCase('string')).toBe('string');
    expect(toCamelCase(123)).toBe(123);
    expect(toCamelCase(null)).toBe(null);
    expect(toCamelCase(undefined)).toBe(undefined);
  });
});

describe('toSnakeCase', () => {
  it('converts camelCase to snake_case', () => {
    const obj = {camelCase: 'value', anotherKey: 'another_value'};

    expect(toSnakeCase(obj)).toEqual({
      camel_case: 'value',
      another_key: 'another_value',
    });
  });

  it('preserves keys when specified', () => {
    const obj = {
      camelCase: {
        anotherCamelCase: 'anotherCamelCase',
      },
      anotherKey: 'another_value',
    };

    expect(toSnakeCase(obj, ['camelCase'])).toEqual({
      camel_case: {
        anotherCamelCase: 'anotherCamelCase',
      },
      another_key: 'another_value',
    });
  });

  it('handles nested objects', () => {
    const obj = {camelCase: {nestedKey: 'nested_value'}};

    expect(toSnakeCase(obj)).toEqual({
      camel_case: {nested_key: 'nested_value'},
    });
  });

  it('handles arrays', () => {
    const obj = {camelCase: [{nestedKey: 'nested_value'}]};

    expect(toSnakeCase(obj)).toEqual({
      camel_case: [{nested_key: 'nested_value'}],
    });
  });

  it('handles top-level arrays', () => {
    const obj = [{camelCase: 'value'}];
    expect(toSnakeCase(obj)).toEqual([{camel_case: 'value'}]);
  });

  it('preserves keys using dot notation', () => {
    const obj = {
      camelCase: {
        nestedKey: {
          nestedNestedKey: 'value',
        },
        anotherNested: 'value',
      },
    };
    expect(toSnakeCase(obj, ['camelCase.nestedKey'])).toEqual({
      camel_case: {
        nested_key: {
          nestedNestedKey: 'value',
        },
        another_nested: 'value',
      },
    });
  });

  it('handles primitives', () => {
    expect(toSnakeCase('string')).toBe('string');
    expect(toSnakeCase(123)).toBe(123);
    expect(toSnakeCase(null)).toBe(null);
    expect(toSnakeCase(undefined)).toBe(undefined);
  });
});

describe('toCamelCase with dropNulls', () => {
  it('drops properties whose value is null', () => {
    expect(
      toCamelCase({name: 'a', a_description: null, count: 0}, [], true),
    ).toEqual({name: 'a', count: 0});
  });

  it('keeps a null property when dropNulls is off', () => {
    expect(toCamelCase({a_description: null})).toEqual({aDescription: null});
  });

  it('drops nested and in-array null properties', () => {
    expect(
      toCamelCase(
        {cases: [{id: 'a', session_input: null, data: {inner: null, kept: 1}}]},
        [],
        true,
      ),
    ).toEqual({cases: [{id: 'a', data: {kept: 1}}]});
  });

  it('keeps a null held under a preserved path', () => {
    expect(
      toCamelCase(
        {tool: {args: {opt_out: null}, id: null}},
        ['tool.args'],
        true,
      ),
    ).toEqual({tool: {args: {opt_out: null}}});
  });

  it('passes primitives and a bare null through', () => {
    expect(toCamelCase('string', [], true)).toBe('string');
    expect(toCamelCase(null, [], true)).toBe(null);
    expect(toCamelCase(undefined, [], true)).toBe(undefined);
  });
});
