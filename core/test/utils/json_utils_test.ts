/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  asJsonObject,
  isJsonObject,
  isRecord,
  parseFencedJson,
  readOwn,
  readOwnString,
  readString,
  safeJsonLoads,
  stableJsonStringify,
  toJsonObject,
  toJsonSerializable,
  toJsonText,
  toJsonValue,
} from '../../src/utils/json_utils.js';

describe('toJsonText', () => {
  it('serializes a plain value', () => {
    expect(toJsonText({a: 1})).toBe('{"a":1}');
  });

  it('falls back to the string form for a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(toJsonText(circular)).toBe('[object Object]');
  });

  it('falls back to the string form for a bigint', () => {
    expect(toJsonText(7n)).toBe('7');
  });

  it('falls back to the string form for undefined', () => {
    expect(toJsonText(undefined)).toBe('undefined');
  });
});

describe('toJsonValue', () => {
  it('copies nested structures', () => {
    expect(toJsonValue({a: [1, 'b', true], c: {d: null}})).toEqual({
      a: [1, 'b', true],
      c: {d: null},
    });
  });

  it('drops object fields JSON cannot represent', () => {
    expect(toJsonValue({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
    expect(toJsonValue(undefined)).toBeUndefined();
  });

  it('renders an unrepresentable array member as null', () => {
    expect(toJsonValue([undefined, 1])).toEqual([null, 1]);
  });

  it('rejects a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => toJsonValue(circular)).toThrow(TypeError);
  });
});

describe('isJsonObject', () => {
  it('recognises plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('a')).toBe(false);
  });
});

describe('toJsonObject', () => {
  it('deep-copies an object into JSON', () => {
    const source = {a: [1, 'b'], c: {d: null}};
    const copy = toJsonObject(source);
    expect(copy).toEqual(source);
    expect(copy['c']).not.toBe(source.c);
  });

  it('drops values JSON cannot represent', () => {
    expect(toJsonObject({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
  });

  it('returns an empty object for a value that is not one', () => {
    expect(toJsonObject([1, 2])).toEqual({});
  });

  it('returns an empty object for a toJSON that yields a string', () => {
    expect(toJsonObject(new Date('2026-01-01T00:00:00Z'))).toEqual({});
  });
});

describe('asJsonObject', () => {
  it('returns a plain object unchanged', () => {
    expect(asJsonObject({a: 1})).toEqual({a: 1});
  });

  it('rejects null, an array and a primitive', () => {
    expect(asJsonObject(null)).toBeUndefined();
    expect(asJsonObject([1, 2])).toBeUndefined();
    expect(asJsonObject('text')).toBeUndefined();
    expect(asJsonObject(undefined)).toBeUndefined();
  });
});

describe('readString', () => {
  it('returns the string value of a field', () => {
    expect(readString({name: 'value'}, 'name')).toBe('value');
  });

  it('returns an empty string for a missing or non-string field', () => {
    expect(readString({}, 'name')).toBe('');
    expect(readString({name: 42}, 'name')).toBe('');
  });
});

describe('toJsonSerializable', () => {
  it('returns plain values unchanged', () => {
    const value = {a: 1, b: [1, 2], c: {d: 'e'}, f: null, g: true};
    expect(toJsonSerializable(value)).toEqual(value);
  });

  it('returns a primitive unchanged', () => {
    expect(toJsonSerializable('text')).toBe('text');
    expect(toJsonSerializable(7)).toBe(7);
    expect(toJsonSerializable(false)).toBe(false);
    expect(toJsonSerializable(null)).toBeNull();
    expect(toJsonSerializable(undefined)).toBeUndefined();
  });

  it('converts a Date through toJSON instead of discarding it', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(toJsonSerializable(date)).toBe('2024-01-02T03:04:05.000Z');
  });

  it('converts nested rich types in place', () => {
    const result = toJsonSerializable({
      when: new Date('2024-05-06T00:00:00.000Z'),
      n: [1],
    });
    expect(result).toEqual({when: '2024-05-06T00:00:00.000Z', n: [1]});
  });

  it('replaces a function with a string naming it', () => {
    function namedCallback() {
      return 1;
    }
    expect(toJsonSerializable(namedCallback)).toBe('[Function: namedCallback]');
  });

  it('names an unnamed function anonymous', () => {
    const anonymous = {run: function () {}};
    Object.defineProperty(anonymous.run, 'name', {value: ''});
    expect(toJsonSerializable(anonymous)).toEqual({
      run: '[Function: anonymous]',
    });
  });

  it('replaces a nested function and keeps its siblings', () => {
    const result = toJsonSerializable({cb: () => 1, ok: 2});
    expect(result).toEqual({cb: expect.stringContaining('Function'), ok: 2});
  });

  it('replaces a bigint with its decimal string', () => {
    expect(toJsonSerializable({big: 9007199254740993n})).toEqual({
      big: '9007199254740993',
    });
  });

  it('replaces a symbol with its description', () => {
    expect(toJsonSerializable({sym: Symbol('token')})).toEqual({
      sym: 'Symbol(token)',
    });
  });

  it('replaces a circular reference', () => {
    const cycle: Record<string, unknown> = {name: 'root'};
    cycle['self'] = cycle;
    expect(toJsonSerializable(cycle)).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });

  it('keeps a value repeated in two places rather than calling it circular', () => {
    const shared = {n: 1};
    expect(toJsonSerializable({a: shared, b: shared})).toEqual({
      a: {n: 1},
      b: {n: 1},
    });
  });

  it('replaces a toJSON that returns the object itself', () => {
    const selfReferential = {
      toJSON() {
        return selfReferential;
      },
    };
    expect(toJsonSerializable(selfReferential)).toBe('[Circular]');
  });

  it('converts array entries and replaces an unserializable one', () => {
    let replacements = 0;
    const result = toJsonSerializable({items: [1, () => 2]}, () => {
      replacements++;
    });
    expect(result).toEqual({items: [1, expect.stringContaining('Function')]});
    expect(replacements).toBe(1);
  });

  it('omits an undefined property, matching JSON.stringify', () => {
    expect(toJsonSerializable({a: undefined, b: 1})).toEqual({b: 1});
    expect(
      Object.keys(toJsonSerializable({a: undefined, b: 1}) as object),
    ).toEqual(['b']);
  });

  it('produces output that JSON.stringify accepts', () => {
    const cycle: Record<string, unknown> = {big: 1n, sym: Symbol('s')};
    cycle['self'] = cycle;
    expect(() => JSON.stringify(toJsonSerializable(cycle))).not.toThrow();
  });

  it('reports once for every replaced value, however deeply nested', () => {
    let replacements = 0;
    toJsonSerializable({cb: () => 1, nested: {cb: () => 2, ok: 3}}, () => {
      replacements++;
    });
    expect(replacements).toBe(2);
  });

  it('reports a replaced top-level value', () => {
    let replacements = 0;
    toJsonSerializable(
      () => 1,
      () => {
        replacements++;
      },
    );
    expect(replacements).toBe(1);
  });

  it('does not report anything for a fully serializable value', () => {
    let replacements = 0;
    toJsonSerializable({a: 1, b: {c: [true, null]}}, () => {
      replacements++;
    });
    expect(replacements).toBe(0);
  });
});

describe('stableJsonStringify', () => {
  it('sorts the top-level keys whatever their insertion order', () => {
    expect(stableJsonStringify({product: 'shoes', brand: 'Nike'})).toBe(
      '{"brand":"Nike","product":"shoes"}',
    );
    expect(stableJsonStringify({brand: 'Nike', product: 'shoes'})).toBe(
      '{"brand":"Nike","product":"shoes"}',
    );
  });

  it('sorts the keys of a nested object', () => {
    expect(stableJsonStringify({outer: {b: 2, a: 1}})).toBe(
      '{"outer":{"a":1,"b":2}}',
    );
  });

  it('sorts the keys of an object nested inside an array', () => {
    expect(stableJsonStringify({items: [{b: 2, a: 1}]})).toBe(
      '{"items":[{"a":1,"b":2}]}',
    );
  });

  it('preserves the order of array elements', () => {
    expect(stableJsonStringify({list: [3, 1, 2]})).toBe('{"list":[3,1,2]}');
  });

  it('keeps non-ASCII characters literal', () => {
    expect(stableJsonStringify({greeting: 'héllo 😀'})).toBe(
      '{"greeting":"héllo 😀"}',
    );
  });

  it('serializes an empty object, null and a primitive', () => {
    expect(stableJsonStringify({})).toBe('{}');
    expect(stableJsonStringify(null)).toBe('null');
    expect(stableJsonStringify({value: null})).toBe('{"value":null}');
    expect(stableJsonStringify(7)).toBe('7');
    expect(stableJsonStringify('text')).toBe('"text"');
  });

  it('omits an undefined property, the way JSON.stringify does', () => {
    expect(stableJsonStringify({b: undefined, a: 1})).toBe('{"a":1}');
  });
});

describe('safeJsonLoads', () => {
  it('parses an object', () => {
    expect(safeJsonLoads('{"city": "Paris", "days": 2}')).toEqual({
      city: 'Paris',
      days: 2,
    });
  });

  it('parses a scalar', () => {
    expect(safeJsonLoads('42')).toBe(42);
  });

  it('reports malformed input as an Error, not a SyntaxError', () => {
    expect(() => safeJsonLoads('{"city": "Par')).toThrowError(
      /^Invalid JSON: /,
    );
    expect(() => safeJsonLoads('{"city": "Par')).not.toThrowError(SyntaxError);
  });

  it('names the source of the text when a context is given', () => {
    expect(() => safeJsonLoads('{"city": "Par', 'session state')).toThrowError(
      /^Invalid JSON in session state: /,
    );
  });

  it('keeps the parse failure as the cause', () => {
    let caught: unknown;
    try {
      safeJsonLoads('not json');
    } catch (err: unknown) {
      caught = err;
    }
    if (!(caught instanceof Error)) {
      return expect.fail('safeJsonLoads must throw an Error');
    }
    expect(caught.cause).toBeInstanceOf(SyntaxError);
  });
});

describe('isRecord', () => {
  it.each([
    {label: 'an object', value: {a: 1}, expected: true},
    {label: 'an empty object', value: {}, expected: true},
    {label: 'an array', value: [1, 2], expected: false},
    {label: 'null', value: null, expected: false},
    {label: 'a string', value: 'text', expected: false},
    {label: 'a number', value: 7, expected: false},
    {label: 'undefined', value: undefined, expected: false},
  ])('reports $label as $expected', ({value, expected}) => {
    expect(isRecord(value)).toBe(expected);
  });
});

// The cases below arrived with PR #1757, which added `json_utils.ts`
// independently. They are kept as written: they cover the same three
// functions from a second angle.

describe('safeJsonLoads', () => {
  it('returns the parsed value', () => {
    expect(safeJsonLoads('{"a":1}')).toEqual({a: 1});
  });

  it('names the context in the error message', () => {
    expect(() => safeJsonLoads('{oops', 'session state')).toThrow(
      /^Invalid JSON in session state: /,
    );
  });

  it('omits the context clause when none is given', () => {
    expect(() => safeJsonLoads('{oops')).toThrow(/^Invalid JSON: /);
  });

  it('keeps the parser error as the cause', () => {
    let thrown: unknown;
    try {
      safeJsonLoads('{oops', 'app state');
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
  });
});

describe('isRecord', () => {
  it.each([
    ['an object', {}, true],
    ['an array', [1, 2, 3], false],
    ['null', null, false],
    ['a string', 'x', false],
    ['a number', 3, false],
  ])('reports %s as %s', (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('toJsonSerializable', () => {
  it('leaves a value JSON can already represent alone', () => {
    const onReplace = vi.fn();
    expect(
      toJsonSerializable({a: 1, b: 'two', c: [true, null]}, onReplace),
    ).toEqual({a: 1, b: 'two', c: [true, null]});
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('replaces a named function with its name', () => {
    const onReplace = vi.fn();
    function onDone() {}
    expect(toJsonSerializable({onDone}, onReplace)).toEqual({
      onDone: '[Function: onDone]',
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('replaces an anonymous function', () => {
    expect(toJsonSerializable([() => {}])).toEqual(['[Function: anonymous]']);
  });

  it('replaces a symbol with its description', () => {
    expect(toJsonSerializable(Symbol('tag'))).toBe('Symbol(tag)');
  });

  it('replaces a BigInt with its digits', () => {
    expect(toJsonSerializable({retries: 3n})).toEqual({retries: '3'});
  });

  it('replaces a back reference and still converts the rest', () => {
    const onReplace = vi.fn();
    const node: Record<string, unknown> = {name: 'root'};
    node['self'] = node;
    expect(toJsonSerializable(node, onReplace)).toEqual({
      name: 'root',
      self: '[Circular]',
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('keeps a repeated sibling that is not a cycle', () => {
    const shared = {id: 1};
    expect(toJsonSerializable({a: shared, b: shared})).toEqual({
      a: {id: 1},
      b: {id: 1},
    });
  });

  it('converts a Date through its toJSON', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(toJsonSerializable({at})).toEqual({at: '2026-01-02T03:04:05.000Z'});
  });

  it('drops an undefined property, as JSON.stringify does', () => {
    expect(toJsonSerializable({a: 1, b: undefined})).toEqual({a: 1});
  });

  it('converts the members of an array', () => {
    expect(toJsonSerializable([1n, 'x'])).toEqual(['1', 'x']);
  });

  it('returns a primitive unchanged', () => {
    expect(toJsonSerializable(null)).toBeNull();
    expect(toJsonSerializable(7)).toBe(7);
  });

  it('reports every replacement, not just the first', () => {
    const onReplace = vi.fn();
    toJsonSerializable({a: 1n, b: 2n}, onReplace);
    expect(onReplace).toHaveBeenCalledTimes(2);
  });
});

// The cases below arrived with PR #1856, which added `json_utils.ts`
// independently. They are kept as written: they cover `isJsonObject` from a
// second angle, and they are the only cases for `parseFencedJson`.

describe('isJsonObject', () => {
  it('accepts a keyed object', () => {
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it('rejects an array', () => {
    expect(isJsonObject([1, 2])).toBe(false);
  });

  it('rejects null', () => {
    expect(isJsonObject(null)).toBe(false);
  });

  it('rejects a scalar', () => {
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject('text')).toBe(false);
  });
});

describe('parseFencedJson', () => {
  it('parses plain JSON', () => {
    expect(parseFencedJson('{"a": 1}')).toEqual({a: 1});
  });

  it('strips a fence that names a language', () => {
    expect(parseFencedJson('```json\n{"a": 1}\n```')).toEqual({a: 1});
  });

  it('strips a fence that names no language', () => {
    expect(parseFencedJson('```\n{"a": 1}\n```')).toEqual({a: 1});
  });

  it('strips a fence whose answer ends with a newline', () => {
    // The ordinary shape of a fenced model answer. adk-python's `$` matches
    // just before a trailing newline and JavaScript's does not, so the fence
    // has to be reachable after trimming.
    expect(parseFencedJson('```json\n{"a": 1}\n```\n')).toEqual({a: 1});
  });

  it('strips a fence padded with whitespace on both sides', () => {
    expect(parseFencedJson('\n  ```json\n{"a": 1}\n```  \n')).toEqual({a: 1});
  });

  it('strips a fence whose answer ends with a carriage return', () => {
    expect(parseFencedJson('```json\n{"a": 1}\n```\r\n')).toEqual({a: 1});
  });

  it('trims surrounding whitespace', () => {
    expect(parseFencedJson('  \n{"a": 1}\n  ')).toEqual({a: 1});
  });

  it('leaves a fence in the middle of the text alone', () => {
    expect(parseFencedJson('{"a": "```"}')).toEqual({a: '```'});
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseFencedJson('sorry, I cannot do that')).toBeUndefined();
  });

  it('returns undefined for the empty string', () => {
    expect(parseFencedJson('')).toBeUndefined();
  });

  it('returns the parsed scalar for a JSON scalar', () => {
    expect(parseFencedJson('42')).toBe(42);
    expect(parseFencedJson('null')).toBeNull();
  });
});

describe('readOwn', () => {
  it('returns the value of an own property', () => {
    expect(readOwn({skills: [1, 2]}, 'skills')).toEqual([1, 2]);
    expect(readOwn({count: 0}, 'count')).toBe(0);
  });

  it('returns undefined for a property the value does not carry', () => {
    expect(readOwn({}, 'skills')).toBeUndefined();
  });

  it('returns undefined for an inherited property', () => {
    expect(readOwn({}, 'toString')).toBeUndefined();
    expect(readOwn(Object.create({skills: [1]}), 'skills')).toBeUndefined();
  });

  it.each([[null], [undefined], ['text'], [7], [true]])(
    'returns undefined for %s, which carries no own properties',
    (value) => {
      expect(readOwn(value, 'skills')).toBeUndefined();
    },
  );
});

describe('readOwnString', () => {
  it('returns a string property, including the empty string', () => {
    expect(readOwnString({name: 'my-skill'}, 'name')).toBe('my-skill');
    expect(readOwnString({name: ''}, 'name')).toBe('');
  });

  it.each([[7], [null], [['a']], [{}], [undefined], [false]])(
    'returns undefined when the property is %s rather than a string',
    (value) => {
      expect(readOwnString({name: value}, 'name')).toBeUndefined();
    },
  );

  it('returns undefined when the value is not an object', () => {
    expect(readOwnString('text', 'name')).toBeUndefined();
  });
});
