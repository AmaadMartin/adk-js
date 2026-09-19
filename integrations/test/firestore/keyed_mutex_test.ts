/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {KeyedMutex} from '../../src/firestore/keyed_mutex.js';

/** A promise a test resolves by hand. */
function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {promise, resolve};
}

describe('KeyedMutex', () => {
  it('runs one task at a time for the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = deferred();

    const one = mutex.runExclusive('k', async () => {
      order.push('one:start');
      await first.promise;
      order.push('one:end');
    });
    const two = mutex.runExclusive('k', () => {
      order.push('two:start');
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual(['one:start']);

    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(['one:start', 'one:end', 'two:start']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const blocked = deferred();

    const one = mutex.runExclusive('a', async () => {
      order.push('a:start');
      await blocked.promise;
    });
    const two = mutex.runExclusive('b', () => {
      order.push('b:start');
      return Promise.resolve();
    });

    await two;
    expect(order).toEqual(['a:start', 'b:start']);

    blocked.resolve();
    await one;
  });

  it('forgets a key once its last user leaves', async () => {
    const mutex = new KeyedMutex();

    await mutex.runExclusive('k', () => Promise.resolve());

    expect(mutex.size).toBe(0);
  });

  it('keeps the key while a caller is still waiting for it', async () => {
    const mutex = new KeyedMutex();
    const held = deferred();

    const one = mutex.runExclusive('k', () => held.promise);
    const two = mutex.runExclusive('k', () => Promise.resolve());
    expect(mutex.size).toBe(1);

    held.resolve();
    await Promise.all([one, two]);
    expect(mutex.size).toBe(0);
  });

  it('releases the key when the task rejects, and propagates', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(mutex.size).toBe(0);
    await expect(
      mutex.runExclusive('k', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  it('lets a later caller through after the key was forgotten', async () => {
    const mutex = new KeyedMutex();

    await mutex.runExclusive('k', () => Promise.resolve());
    const result = await mutex.runExclusive('k', () => Promise.resolve(7));

    expect(result).toBe(7);
    expect(mutex.size).toBe(0);
  });
});
