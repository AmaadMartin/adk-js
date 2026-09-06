/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {parseDuration} from '../../src/utils/duration_utils.js';

describe('parseDuration', () => {
  it.each([
    ['30', 30000],
    ['30s', 30000],
    ['5m', 300000],
    ['0s', 0],
    ['1m', 60000],
  ])('reads %s as %d ms', (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it.each(['abc', '30h', '-5s', '1.5s', '', ' 30s', '30 s', 's'])(
    'rejects %o',
    (value) => {
      expect(() => parseDuration(value)).toThrow(
        `Invalid timeout format: ${value}`,
      );
    },
  );
});
