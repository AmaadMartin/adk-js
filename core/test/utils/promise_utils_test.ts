/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {resolvesWithin} from '../../src/utils/promise_utils.js';

describe('resolvesWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports true when the promise resolves before the wait expires', async () => {
    await expect(resolvesWithin(Promise.resolve('done'), 5)).resolves.toBe(
      true,
    );
  });

  it('reports false when the wait expires first', async () => {
    vi.useFakeTimers();

    const pending = resolvesWithin(new Promise<void>(() => {}), 5);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBe(false);
  });

  it('keeps waiting just before the timeout elapses', async () => {
    vi.useFakeTimers();
    let settle: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const pending = resolvesWithin(slow, 5);
    await vi.advanceTimersByTimeAsync(4999);
    settle();

    await expect(pending).resolves.toBe(true);
  });

  it('rejects with the reason the promise rejected with', async () => {
    const boom = new Error('socket still busy');

    await expect(resolvesWithin(Promise.reject(boom), 5)).rejects.toBe(boom);
  });

  it('waits indefinitely when the timeout is zero or less', async () => {
    vi.useFakeTimers();
    let settle: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const pending = resolvesWithin(slow, 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);

    settle();
    await expect(pending).resolves.toBe(true);
  });

  it('clears the timer once the promise resolves', async () => {
    vi.useFakeTimers();

    await resolvesWithin(Promise.resolve(), 5);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer once the promise rejects', async () => {
    vi.useFakeTimers();

    await expect(
      resolvesWithin(Promise.reject(new Error('nope')), 5),
    ).rejects.toThrow('nope');

    expect(vi.getTimerCount()).toBe(0);
  });
});
