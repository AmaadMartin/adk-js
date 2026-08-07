/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {AsyncLocalStorage} from '../../src/utils/async_hooks_shim.js';

const NO_ASYNC_CONTEXT = /no async context/;

/** Yields to the macrotask queue so pending timers and promises can run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('async_hooks_shim', () => {
  describe('AsyncLocalStorage with a synchronous callback', () => {
    it('exposes the store to the callback and restores it afterwards', () => {
      const als = new AsyncLocalStorage<string>();

      expect(als.getStore()).toBeUndefined();
      expect(als.run('a', () => als.getStore())).toBe('a');
      expect(als.getStore()).toBeUndefined();
    });

    it('restores the outer store when runs are nested', () => {
      const als = new AsyncLocalStorage<string>();

      const inner = als.run('a', () => {
        const nested = als.run('b', () => als.getStore());
        expect(nested).toBe('b');
        return als.getStore();
      });

      expect(inner).toBe('a');
      expect(als.getStore()).toBeUndefined();
    });

    it('restores the previous store when the callback throws', () => {
      const als = new AsyncLocalStorage<string>();
      const boom = new Error('boom');

      expect(() =>
        als.run('a', () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(als.getStore()).toBeUndefined();

      als.run('outer', () => {
        expect(() =>
          als.run('inner', () => {
            throw boom;
          }),
        ).toThrow(boom);
        expect(als.getStore()).toBe('outer');
      });
    });

    it('returns non-thenable values unchanged', () => {
      const als = new AsyncLocalStorage<string>();
      const plainFunction = () => 'not a thenable';
      const plainObject = {value: 1};

      expect(als.run('a', () => null)).toBeNull();
      expect(als.run('a', () => undefined)).toBeUndefined();
      expect(als.run('a', () => plainFunction)).toBe(plainFunction);
      expect(als.run('a', () => plainObject)).toBe(plainObject);
      expect(als.getStore()).toBeUndefined();
    });

    it('does not propagate into deferred work scheduled by a synchronous callback', async () => {
      const als = new AsyncLocalStorage<string>();
      let deferred: string | undefined = 'unset';

      als.run('a', () => {
        setTimeout(() => {
          deferred = als.getStore();
        }, 0);
      });
      await tick();

      expect(deferred).toBeUndefined();
    });
  });

  describe('AsyncLocalStorage instance isolation', () => {
    it('reads undefined on a fresh instance and keeps instances separate', () => {
      const first = new AsyncLocalStorage<string>();
      const second = new AsyncLocalStorage<string>();

      expect(first.getStore()).toBeUndefined();
      first.run('a', () => {
        expect(second.getStore()).toBeUndefined();
      });
      expect(second.getStore()).toBeUndefined();
    });
  });

  describe('AsyncLocalStorage with a callback that returns a thenable', () => {
    it('throws for an async callback and restores the previous store', () => {
      const als = new AsyncLocalStorage<string>();

      expect(() => als.run('a', async () => als.getStore())).toThrow(
        NO_ASYNC_CONTEXT,
      );
      expect(als.getStore()).toBeUndefined();
    });

    it('throws for a hand-rolled thenable, not just for an async function', () => {
      const als = new AsyncLocalStorage<string>();

      expect(() =>
        als.run('a', () => ({
          then(resolve: (value: number) => void) {
            resolve(1);
          },
        })),
      ).toThrow(NO_ASYNC_CONTEXT);
      expect(als.getStore()).toBeUndefined();
    });

    it('throws for both of two interleaving async runs instead of losing their stores', async () => {
      const als = new AsyncLocalStorage<string>();
      const afterAwait: Array<string | undefined> = [];
      const callback = async () => {
        await Promise.resolve();
        afterAwait.push(als.getStore());
      };

      expect(() => als.run('a', callback)).toThrow(NO_ASYNC_CONTEXT);
      expect(() => als.run('b', callback)).toThrow(NO_ASYNC_CONTEXT);

      expect(afterAwait).toEqual([]);
      expect(als.getStore()).toBeUndefined();

      await tick();
      expect(afterAwait).toEqual([undefined, undefined]);
    });

    describe('when the callback rejects', () => {
      const unhandled = vi.fn();

      afterEach(() => {
        process.off('unhandledRejection', unhandled);
        unhandled.mockReset();
      });

      it('throws without also raising an unhandled rejection', async () => {
        const als = new AsyncLocalStorage<string>();
        process.on('unhandledRejection', unhandled);

        expect(() =>
          als.run('a', async () => {
            throw new Error('boom');
          }),
        ).toThrow(NO_ASYNC_CONTEXT);

        await tick();
        await tick();
        expect(unhandled).not.toHaveBeenCalled();
      });
    });
  });
});
