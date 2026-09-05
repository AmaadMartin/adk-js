/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {runSerialized} from '../../src/utils/serial_queue.js';

/** A promise plus the handle that settles it. */
function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {promise, resolve};
}

describe('runSerialized', () => {
  it('runs work under one key in submission order', async () => {
    const queue = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const first = deferred();

    const a = runSerialized(queue, 'k', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = runSerialized(queue, 'k', async () => {
      order.push('b:start');
    });

    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('runs work under different keys concurrently', async () => {
    const queue = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const blocked = deferred();

    const a = runSerialized(queue, 'k1', async () => {
      order.push('a:start');
      await blocked.promise;
      order.push('a:end');
    });
    const b = runSerialized(queue, 'k2', async () => {
      order.push('b:start');
    });

    await b;
    expect(order).toEqual(['a:start', 'b:start']);
    blocked.resolve();
    await a;
    expect(order).toEqual(['a:start', 'b:start', 'a:end']);
  });

  it('returns what the work resolves to', async () => {
    const queue = new Map<string, Promise<unknown>>();
    await expect(runSerialized(queue, 'k', async () => 42)).resolves.toBe(42);
  });

  it('empties the queue once the last item settles', async () => {
    const queue = new Map<string, Promise<unknown>>();

    await Promise.all([
      runSerialized(queue, 'k1', async () => undefined),
      runSerialized(queue, 'k1', async () => undefined),
      runSerialized(queue, 'k2', async () => undefined),
    ]);
    // The cleanup runs a microtask after the work settles.
    await Promise.resolve();

    expect(queue.size).toBe(0);
  });

  it('lets a failure through to its caller and not to the next item', async () => {
    const queue = new Map<string, Promise<unknown>>();
    const failure = new Error('boom');

    const a = runSerialized(queue, 'k', async () => {
      throw failure;
    });
    const b = runSerialized(queue, 'k', async () => 'ran');

    await expect(a).rejects.toBe(failure);
    await expect(b).resolves.toBe('ran');
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});
