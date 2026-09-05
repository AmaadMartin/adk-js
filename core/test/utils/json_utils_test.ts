/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  isRecord,
  safeJsonLoads,
  toJsonSerializable,
} from '../../src/utils/json_utils.js';

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
