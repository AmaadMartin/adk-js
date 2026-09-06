/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {compareSessionIds} from '../../src/sessions/session.js';

describe('compareSessionIds', () => {
  it('returns -1 when the first id sorts first', () => {
    expect(compareSessionIds('A', 'B')).toBe(-1);
    expect(compareSessionIds('Z', 'a')).toBe(-1);
  });

  it('returns 1 when the first id sorts last', () => {
    expect(compareSessionIds('B', 'A')).toBe(1);
    expect(compareSessionIds('a', 'Z')).toBe(1);
  });

  it('returns 0 for equal ids', () => {
    expect(compareSessionIds('s1', 's1')).toBe(0);
  });

  it('orders mixed-case ids by code unit, not by locale', () => {
    expect(['B', 'a', 'A', 'b'].sort(compareSessionIds)).toEqual([
      'A',
      'B',
      'a',
      'b',
    ]);
  });
});
