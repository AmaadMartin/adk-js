/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  isBaseCriterion,
  parseBaseCriterion,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('isBaseCriterion', () => {
  it('accepts a finite numeric threshold', () => {
    expect(isBaseCriterion({threshold: 0})).toBe(true);
  });

  it('accepts a criterion carrying extra keys', () => {
    expect(isBaseCriterion({threshold: 1, matchType: 'EXACT'})).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an object with no threshold', {}],
    ['a non-numeric threshold', {threshold: '1'}],
    ['a NaN threshold', {threshold: Number.NaN}],
    ['an infinite threshold', {threshold: Number.POSITIVE_INFINITY}],
  ])('rejects %s', (_name, raw) => {
    expect(isBaseCriterion(raw)).toBe(false);
  });
});

describe('parseBaseCriterion', () => {
  it('returns the criterion unchanged, keeping its extra keys', () => {
    const raw = {threshold: 0.7, extra: 'kept'};

    const parsed = parseBaseCriterion(raw);

    expect(parsed).toBe(raw);
    expect(parsed).toEqual({threshold: 0.7, extra: 'kept'});
  });

  it('rejects a value that is not a criterion, naming the expected type', () => {
    expect(() => parseBaseCriterion({})).toThrowError(
      new InputValidationError('Expected a criterion of type `BaseCriterion`.'),
    );
  });
});
