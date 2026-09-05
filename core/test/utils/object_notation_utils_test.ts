/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isRecord,
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

describe('preserveKeysAtAnyDepth', () => {
  const OPAQUE: ReadonlySet<string> = new Set(['args']);

  it('preserves the value of a named key however deep it sits', () => {
    const obj = {
      outer_key: {inner_key: {args: {tool_arg: 1}, other_key: {nested_key: 2}}},
    };

    expect(toCamelCase(obj, [], OPAQUE)).toEqual({
      outerKey: {innerKey: {args: {tool_arg: 1}, otherKey: {nestedKey: 2}}},
    });
  });

  it('preserves a named key inside an array element', () => {
    const obj = {calls: [{args: {tool_arg: 1}, call_id: 'a'}]};

    expect(toCamelCase(obj, [], OPAQUE)).toEqual({
      calls: [{args: {tool_arg: 1}, callId: 'a'}],
    });
  });

  it('converts every key when no key is named', () => {
    const obj = {outer_key: {args: {tool_arg: 1}}};

    expect(toCamelCase(obj)).toEqual({outerKey: {args: {toolArg: 1}}});
  });

  it('preserves a named key when converting to snake_case', () => {
    const obj = {outerKey: {args: {toolArg: 1}}};

    expect(toSnakeCase(obj, [], OPAQUE)).toEqual({
      outer_key: {args: {toolArg: 1}},
    });
  });
});

describe('isRecord', () => {
  it.each([
    ['a plain object', {}, true],
    ['an object with keys', {a: 1}, true],
    ['an array', [1], false],
    ['null', null, false],
    ['a string', 'x', false],
    ['a number', 1, false],
    ['undefined', undefined, false],
  ])('reports %s as %s', (_name, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});
