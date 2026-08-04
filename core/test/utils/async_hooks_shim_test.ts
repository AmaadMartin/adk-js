/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AsyncLocalStorage} from '../../src/utils/async_hooks_shim.js';

describe('async_hooks_shim', () => {
  describe('AsyncLocalStorage', () => {
    it('has no store before any run', () => {
      const storage = new AsyncLocalStorage<string>();
      expect(storage.getStore()).toBeUndefined();
    });

    it('exposes the store inside run and returns the callback result', () => {
      const storage = new AsyncLocalStorage<string>();
      const result = storage.run('a', () => storage.getStore());
      expect(result).toBe('a');
    });

    it('restores the outer value when a nested run returns', () => {
      const storage = new AsyncLocalStorage<string>();
      const seen: Array<string | undefined> = [];

      storage.run('outer', () => {
        seen.push(storage.getStore());
        storage.run('inner', () => {
          seen.push(storage.getStore());
        });
        seen.push(storage.getStore());
      });
      seen.push(storage.getStore());

      expect(seen).toEqual(['outer', 'inner', 'outer', undefined]);
    });

    it('restores the previous value when the callback throws', () => {
      const storage = new AsyncLocalStorage<string>();

      expect(() =>
        storage.run('outer', () => {
          storage.run('inner', () => {
            throw new Error('boom');
          });
        }),
      ).toThrow('boom');
      expect(storage.getStore()).toBeUndefined();
    });

    it('does not carry the value across an await, unlike AsyncLocalStorage', async () => {
      const storage = new AsyncLocalStorage<string>();

      const afterAwait = await storage.run('a', async () => {
        await Promise.resolve();
        return storage.getStore();
      });

      expect(afterAwait).toBeUndefined();
    });
  });
});
