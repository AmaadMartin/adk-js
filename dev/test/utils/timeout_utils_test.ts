/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  parseTimeout,
  TimeoutError,
  withTimeout,
} from '../../src/utils/timeout_utils.js';

describe('parseTimeout', () => {
  it.each([
    ['30', 30],
    ['30s', 30],
    ['5m', 300],
    ['0', 0],
  ])('reads %s as %d seconds', (value, expected) => {
    expect(parseTimeout(value)).toBe(expected);
  });

  it.each([['abc'], ['30h'], ['1.5s'], [''], ['-1s'], ['30 s']])(
    'rejects %s',
    (value) => {
      expect(() => parseTimeout(value)).toThrow(
        `Invalid timeout format: ${value}`,
      );
    },
  );
});

describe('withTimeout', () => {
  it('returns the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 10)).resolves.toBe(
      'done',
    );
  });

  it('propagates a rejection unchanged', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 10),
    ).rejects.toThrow('boom');
  });

  it('rejects with a TimeoutError when the budget runs out', async () => {
    const never = new Promise<never>(() => {});

    await expect(withTimeout(never, 0)).rejects.toBeInstanceOf(TimeoutError);
  });
});
