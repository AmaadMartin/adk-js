/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {SessionLockMap} from '../../src/firestore/session_lock.js';

/** Resolves on the next macrotask, after every pending microtask has run. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A promise plus the function that resolves it. */
function gate(): {wait: Promise<void>; open: () => void} {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {wait, open};
}

describe('SessionLockMap', () => {
  it('runs callers sharing a key one at a time', async () => {
    const locks = new SessionLockMap();
    const order: string[] = [];
    const first = gate();

    const a = locks.run('k', async () => {
      order.push('a:enter');
      await first.wait;
      order.push('a:exit');
    });
    const b = locks.run('k', async () => {
      order.push('b:enter');
      order.push('b:exit');
    });

    await tick();
    expect(order).toEqual(['a:enter']);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('lets callers with different keys overlap', async () => {
    const locks = new SessionLockMap();
    const order: string[] = [];
    const first = gate();

    const a = locks.run('a', async () => {
      order.push('a:enter');
      await first.wait;
      order.push('a:exit');
    });
    const b = locks.run('b', async () => {
      order.push('b:enter');
      order.push('b:exit');
    });

    expect(locks.size).toBe(2);

    await tick();
    expect(order).toEqual(['a:enter', 'b:enter', 'b:exit']);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:enter', 'b:enter', 'b:exit', 'a:exit']);
  });

  it('serializes a caller that arrives while the key is already held', async () => {
    const locks = new SessionLockMap();
    const order: string[] = [];
    const firstGate = gate();
    const secondGate = gate();

    const a = locks.run('k', async () => {
      order.push('a:enter');
      await firstGate.wait;
      order.push('a:exit');
    });
    const b = locks.run('k', async () => {
      order.push('b:enter');
      await secondGate.wait;
      order.push('b:exit');
    });

    firstGate.open();
    await tick();
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter']);

    // c joins after the first caller released but while the second still
    // holds the key, which is what the reference count exists to handle.
    const c = locks.run('k', async () => {
      order.push('c:enter');
      order.push('c:exit');
    });
    await tick();
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter']);

    secondGate.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual([
      'a:enter',
      'a:exit',
      'b:enter',
      'b:exit',
      'c:enter',
      'c:exit',
    ]);
    expect(locks.size).toBe(0);
  });

  it('holds one entry per key while callers are queued', async () => {
    const locks = new SessionLockMap();
    expect(locks.size).toBe(0);
    const held = gate();

    const running = [
      locks.run('k', () => held.wait),
      locks.run('k', () => held.wait),
      locks.run('k', () => held.wait),
    ];
    expect(locks.size).toBe(1);

    held.open();
    await Promise.all(running);
    expect(locks.size).toBe(0);
  });

  it('releases the entry when the callback rejects, without wedging the key', async () => {
    const locks = new SessionLockMap();

    await expect(
      locks.run('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(locks.size).toBe(0);

    await expect(locks.run('k', () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
    expect(locks.size).toBe(0);
  });

  it('runs a queued caller after the caller ahead of it rejects', async () => {
    const locks = new SessionLockMap();
    const order: string[] = [];
    const failing = gate();

    const a = locks.run('k', async () => {
      order.push('a:enter');
      await failing.wait;
      throw new Error('boom');
    });
    const b = locks.run('k', async () => {
      order.push('b:enter');
    });

    failing.open();
    await expect(a).rejects.toThrow('boom');
    await b;
    expect(order).toEqual(['a:enter', 'b:enter']);
    expect(locks.size).toBe(0);
  });

  it('returns the callback result', async () => {
    const locks = new SessionLockMap();
    await expect(locks.run('k', () => Promise.resolve(42))).resolves.toBe(42);
  });
});
