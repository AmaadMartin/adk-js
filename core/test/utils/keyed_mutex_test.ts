/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {KeyedMutex} from '../../src/utils/keyed_mutex.js';

/** Resolves after the event loop has drained pending microtasks. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('KeyedMutex', () => {
  it('serializes callers that share a key', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const critical = async (name: string) => {
      log.push(`${name}:enter`);
      await tick();
      log.push(`${name}:exit`);
    };

    await Promise.all([
      mutex.runExclusive('k', () => critical('a')),
      mutex.runExclusive('k', () => critical('b')),
      mutex.runExclusive('k', () => critical('c')),
    ]);

    expect(log).toEqual([
      'a:enter',
      'a:exit',
      'b:enter',
      'b:exit',
      'c:enter',
      'c:exit',
    ]);
  });

  it('lets callers with different keys interleave', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const critical = async (name: string) => {
      log.push(`${name}:enter`);
      await tick();
      log.push(`${name}:exit`);
    };

    await Promise.all([
      mutex.runExclusive('k1', () => critical('a')),
      mutex.runExclusive('k2', () => critical('b')),
    ]);

    expect(log).toEqual(['a:enter', 'b:enter', 'a:exit', 'b:exit']);
  });

  it('returns what the callback resolves to', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => 7)).resolves.toBe(7);
  });

  it('propagates a rejection and still releases the key', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const failing = mutex.runExclusive('k', async () => {
      log.push('failing');
      throw new Error('boom');
    });
    const following = mutex.runExclusive('k', async () => {
      log.push('following');
    });

    await expect(failing).rejects.toThrow('boom');
    await following;
    expect(log).toEqual(['failing', 'following']);
    expect(mutex.size).toBe(0);
  });

  it('holds one entry per key while callers are in flight', async () => {
    const mutex = new KeyedMutex();
    let releaseA!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const first = mutex.runExclusive('k', () => blocked);
    const second = mutex.runExclusive('k', async () => undefined);
    const other = mutex.runExclusive('other', () => blocked);
    await tick();

    expect(mutex.size).toBe(2);

    releaseA();
    await Promise.all([first, second, other]);
    expect(mutex.size).toBe(0);
  });

  it('drains its map after repeated cycles on many keys', async () => {
    const mutex = new KeyedMutex();

    for (let round = 0; round < 3; round++) {
      await Promise.all(
        ['a', 'b', 'c'].map((key) =>
          mutex.runExclusive(key, async () => {
            await tick();
          }),
        ),
      );
      expect(mutex.size).toBe(0);
    }
  });
});
