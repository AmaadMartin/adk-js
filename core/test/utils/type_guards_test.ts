/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isRecord} from '../../src/utils/type_guards.js';

describe('isRecord', () => {
  it.each([
    {value: {}, expected: true, label: 'an empty object'},
    {value: {a: 1}, expected: true, label: 'a keyed object'},
    {
      value: Object.create(null),
      expected: true,
      label: 'a null-prototype object',
    },
    {value: [], expected: false, label: 'an array'},
    {value: [1, 2], expected: false, label: 'a populated array'},
    {value: null, expected: false, label: 'null'},
    {value: undefined, expected: false, label: 'undefined'},
    {value: 'a string', expected: false, label: 'a string'},
    {value: 7, expected: false, label: 'a number'},
  ])('returns $expected for $label', ({value, expected}) => {
    expect(isRecord(value)).toBe(expected);
  });

  it('narrows the value so its keys can be read', () => {
    const value: unknown = {name: 'connector'};

    if (!isRecord(value)) {
      expect.fail('the guard rejected a record');
    }
    expect(value['name']).toBe('connector');
  });
});
