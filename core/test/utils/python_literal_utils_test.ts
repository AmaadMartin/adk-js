/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {parsePythonLiteral} from '../../src/utils/python_literal_utils.js';

describe('parsePythonLiteral', () => {
  it('parses a single-quoted dict literal', () => {
    expect(parsePythonLiteral("{'query': 'MATCH (n) RETURN n'}")).toEqual({
      query: 'MATCH (n) RETURN n',
    });
  });

  it('parses a double-quoted dict literal', () => {
    expect(parsePythonLiteral('{"city": "London"}')).toEqual({city: 'London'});
  });

  it('parses mixed quoting in one dict', () => {
    expect(parsePythonLiteral('{\'a\': "one", "b": \'two\'}')).toEqual({
      a: 'one',
      b: 'two',
    });
  });

  it('parses backslash escapes inside strings', () => {
    expect(parsePythonLiteral("{'a': 'it\\'s', 'b': \"x\\ny\"}")).toEqual({
      a: "it's",
      b: 'x\ny',
    });
  });

  it('parses the remaining escape sequences', () => {
    expect(parsePythonLiteral("'\\t\\r\\b\\f\\v\\\\\\\"'")).toBe(
      '\t\r\b\f\v\\"',
    );
  });

  it('treats a backslash before a newline as a line continuation', () => {
    expect(parsePythonLiteral("'a\\\nb'")).toBe('ab');
  });

  it('parses nested dicts and lists', () => {
    expect(
      parsePythonLiteral("{'a': [1, {'b': ['c', None]}], 'd': {'e': True}}"),
    ).toEqual({a: [1, {b: ['c', null]}], d: {e: true}});
  });

  it('maps True, False and None to JavaScript values', () => {
    expect(parsePythonLiteral('[True, False, None]')).toEqual([
      true,
      false,
      null,
    ]);
  });

  it('parses a tuple as an array', () => {
    expect(parsePythonLiteral('(1, 2)')).toEqual([1, 2]);
  });

  it('accepts a trailing comma in a list, tuple and dict', () => {
    expect(parsePythonLiteral('[1, 2,]')).toEqual([1, 2]);
    expect(parsePythonLiteral('(1,)')).toEqual([1]);
    expect(parsePythonLiteral("{'a': 1,}")).toEqual({a: 1});
  });

  it('parses empty containers', () => {
    expect(parsePythonLiteral('{}')).toEqual({});
    expect(parsePythonLiteral('[]')).toEqual([]);
    expect(parsePythonLiteral('()')).toEqual([]);
    expect(parsePythonLiteral("''")).toBe('');
  });

  it('parses negative, floating point and exponent numbers', () => {
    expect(parsePythonLiteral('[-1, 1.5, -0.25, .5, 2e3, 1E-2, +7]')).toEqual([
      -1, 1.5, -0.25, 0.5, 2000, 0.01, 7,
    ]);
  });

  it('renders a non-string dict key as its String() form', () => {
    expect(parsePythonLiteral("{1: 'a', None: 'b', True: 'c'}")).toEqual({
      '1': 'a',
      null: 'b',
      true: 'c',
    });
  });

  it('ignores whitespace and newlines between tokens', () => {
    expect(parsePythonLiteral("  {\n  'a' :\t1 ,\n 'b' : 2 }  ")).toEqual({
      a: 1,
      b: 2,
    });
  });

  it('accepts nesting up to the depth cap', () => {
    const depth = 32;
    const source = '['.repeat(depth) + ']'.repeat(depth);
    expect(parsePythonLiteral(source)).not.toBeUndefined();
  });

  it('rejects nesting past the depth cap', () => {
    const depth = 34;
    const source = '['.repeat(depth) + ']'.repeat(depth);
    expect(parsePythonLiteral(source)).toBeUndefined();
  });

  it('does not evaluate the source', () => {
    expect(parsePythonLiteral("__import__('os').system('touch /tmp/x')")).toBe(
      undefined,
    );
    expect(parsePythonLiteral("open('/etc/passwd').read()")).toBeUndefined();
  });

  it('creates an own property for a __proto__ key', () => {
    const parsed = parsePythonLiteral("{'__proto__': {'polluted': True}}");
    expect(Object.getOwnPropertyNames(parsed)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect({}).not.toHaveProperty('polluted');
  });

  it.each([
    ['an expression', '1 + 1'],
    ['an f-string', "f'{x}'"],
    ['a bare identifier', 'undefined'],
    ['a Python identifier that is not a keyword', 'nan'],
    ['a missing dict value', "{'a': }"],
    ['a missing dict colon', "{'a' 1}"],
    ['a dict with a leading comma', "{, 'a': 1}"],
    ['a list with a leading comma', '[, 1]'],
    ['a missing list separator', '[1 2]'],
    ['a missing dict separator', "{'a': 1 'b': 2}"],
    ['an unterminated string', "'unterminated"],
    ['an unterminated dict', "{'a': 1"],
    ['an unterminated list', '[1, 2'],
    ['an unknown escape sequence', "'\\x41'"],
    ['a trailing backslash in a string', "'abc\\"],
    ['trailing junk after a value', '{} trailing'],
    ['an empty source', ''],
    ['whitespace only', '   '],
    ['a triple-quoted string', "'''abc'''"],
  ])('returns undefined for %s', (_name, source) => {
    expect(parsePythonLiteral(source)).toBeUndefined();
  });
});
