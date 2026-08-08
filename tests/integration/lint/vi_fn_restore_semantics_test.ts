/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the vitest behaviour that the `no-restricted-syntax` rule in
 * `eslint.config.js` exists to prevent, so the rule's message stays true. If
 * a vitest upgrade makes these tests fail, the rule can be retired.
 */

import {describe, expect, it, vi} from 'vitest';

describe('vi.restoreAllMocks() and vi.fn() implementations', () => {
  it('discards an implementation attached after vi.fn()', () => {
    const implementation = vi.fn().mockImplementation(() => 'implementation');
    const returned = vi.fn().mockReturnValue('returned');
    const resolved = vi.fn().mockResolvedValue('resolved');
    const rejected = vi.fn().mockRejectedValue(new Error('rejected'));

    expect(implementation()).toBe('implementation');
    expect(returned()).toBe('returned');

    vi.restoreAllMocks();

    expect(implementation()).toBeUndefined();
    expect(returned()).toBeUndefined();
    expect(resolved()).toBeUndefined();
    expect(rejected()).toBeUndefined();
  });

  it('keeps an implementation passed to the vi.fn() constructor', async () => {
    const returns = vi.fn(() => 'returns');
    const resolves = vi.fn(async () => 'resolves');
    const rejects = vi.fn(async () => {
      throw new Error('rejects');
    });

    vi.restoreAllMocks();

    expect(returns()).toBe('returns');
    await expect(resolves()).resolves.toBe('resolves');
    await expect(rejects()).rejects.toThrow('rejects');
  });
});
