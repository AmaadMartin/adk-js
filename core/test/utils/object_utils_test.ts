/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({hint: 'h'})).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'hint'],
    ['a number', 1],
    ['undefined', undefined],
  ])('refuses %s', (_, value) => {
    expect(isRecord(value)).toBe(false);
  });
});
