/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {readOwn, readString} from '../../src/utils/json_utils.js';

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

describe('readString', () => {
  it('returns a string property, including the empty string', () => {
    expect(readString({name: 'my-skill'}, 'name')).toBe('my-skill');
    expect(readString({name: ''}, 'name')).toBe('');
  });

  it.each([[7], [null], [['a']], [{}], [undefined], [false]])(
    'returns undefined when the property is %s rather than a string',
    (value) => {
      expect(readString({name: value}, 'name')).toBeUndefined();
    },
  );

  it('returns undefined when the value is not an object', () => {
    expect(readString('text', 'name')).toBeUndefined();
  });
});
