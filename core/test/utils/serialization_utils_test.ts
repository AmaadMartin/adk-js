/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {toSerializable} from '../../src/utils/serialization_utils.js';

describe('toSerializable', () => {
  it('returns a primitive, a function and null unchanged', () => {
    const fn = () => 'x';
    expect(toSerializable(1)).toBe(1);
    expect(toSerializable('x')).toBe('x');
    expect(toSerializable(null)).toBeNull();
    expect(toSerializable(undefined)).toBeUndefined();
    expect(toSerializable(fn)).toBe(fn);
  });

  it('copies an already-plain object and array', () => {
    const plain = {a: 1, nested: {b: [1, 2]}};
    expect(toSerializable(plain)).toEqual(plain);
    expect(toSerializable(plain)).not.toBe(plain);
    const list = [1, {a: 2}];
    expect(toSerializable(list)).toEqual(list);
    expect(toSerializable(list)).not.toBe(list);
  });

  it('turns a Set into an array', () => {
    expect(toSerializable(new Set([1, 2]))).toEqual([1, 2]);
    expect(toSerializable(new Set([new Set([1])]))).toEqual([[1]]);
  });

  it('turns a Map into a plain object, stringifying its keys', () => {
    expect(toSerializable(new Map([['a', 1]]))).toEqual({a: 1});
    expect(toSerializable(new Map([[1, new Set(['x'])]]))).toEqual({
      '1': ['x'],
    });
  });

  it('dumps a value through toJSON', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(toSerializable(when)).toBe('2026-01-02T03:04:05.000Z');
    expect(toSerializable({when})).toEqual({when: '2026-01-02T03:04:05.000Z'});
  });

  it('turns a class instance into a plain object', () => {
    class Point {
      constructor(
        readonly x = 1,
        readonly y = 2,
      ) {}
    }
    const flat = toSerializable(new Point());
    expect(flat).toEqual({x: 1, y: 2});
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype);

    class Bag {
      constructor(readonly tags = new Set(['a'])) {}
    }
    expect(toSerializable(new Bag())).toEqual({tags: ['a']});
  });

  it('converts a value nested inside a plain container', () => {
    expect(toSerializable({tags: new Set(['a'])})).toEqual({tags: ['a']});
    expect(toSerializable([new Set(['a'])])).toEqual([['a']]);
  });

  it('terminates on a circular structure', () => {
    const circular: Record<string, unknown> = {name: 'x'};
    circular.self = circular;
    const flat = toSerializable(circular) as Record<string, unknown>;
    expect(flat.name).toBe('x');
    expect(flat.self).toBe(circular);
  });

  it('hands the original back where a cycle closes', () => {
    const circular: Record<string, unknown> = {tags: new Set([1])};
    circular.self = circular;
    const flat = toSerializable(circular) as Record<string, unknown>;
    expect(flat).not.toBe(circular);
    expect(flat.tags).toEqual([1]);
    expect(flat.self).toBe(circular);
  });

  it('returns the original when toJSON throws', () => {
    const broken = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(toSerializable(broken)).toBe(broken);
  });

  it('propagates a throwing property getter', () => {
    // Only toJSON() is guarded. A getter that throws is a defect in the value,
    // and validateOutput turns it into a NodeSchemaValidationError naming the
    // node, which beats silently storing the unflattened object.
    const hostile = {
      get boom(): unknown {
        throw new Error('nope');
      },
    };
    expect(() => toSerializable(hostile)).toThrow('nope');
  });

  it('still flattens the rest of the tree when one toJSON throws', () => {
    const broken = {
      toJSON() {
        throw new Error('nope');
      },
    };
    const flat = toSerializable({broken, tags: new Set(['a'])}) as Record<
      string,
      unknown
    >;
    expect(flat.broken).toBe(broken);
    expect(flat.tags).toEqual(['a']);
  });
});
