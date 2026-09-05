/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isRecord,
  numberField,
  parseJson,
  stringField,
} from '../../src/utils/record_utils.js';

describe('isRecord', () => {
  it.each([[{}], [{a: 1}], [new Date()]])('accepts %o', (value) => {
    expect(isRecord(value)).toBe(true);
  });

  it.each([[null], [undefined], ['text'], [7], [[1, 2]]])(
    'rejects %o',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});

describe('stringField', () => {
  it('reads a string field', () => {
    expect(stringField({name: 'ada'}, 'name')).toBe('ada');
  });

  it('returns undefined for an absent or non-string field', () => {
    expect(stringField({}, 'name')).toBeUndefined();
    expect(stringField({name: 42}, 'name')).toBeUndefined();
  });
});

describe('numberField', () => {
  it('reads a number field', () => {
    expect(numberField({count: 7}, 'count')).toBe(7);
  });

  it('returns undefined for an absent or non-number field', () => {
    expect(numberField({}, 'count')).toBeUndefined();
    expect(numberField({count: '7'}, 'count')).toBeUndefined();
  });
});

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({a: 1});
  });

  it('returns undefined instead of throwing on invalid JSON', () => {
    expect(parseJson('not json at all')).toBeUndefined();
  });
});
