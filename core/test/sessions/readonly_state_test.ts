/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isReadonlyStateError,
  ReadonlyState,
} from '../../src/sessions/readonly_state.js';

/** Returns the value `fn` throws, or undefined when it does not throw. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (e: unknown) {
    return e;
  }
  return undefined;
}

describe('ReadonlyState', () => {
  describe('set', () => {
    it('throws ReadonlyStateError naming the key', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      const err = thrownBy(() => state.set('b', 2));

      if (!isReadonlyStateError(err)) {
        expect.fail(`expected a ReadonlyStateError, got ${String(err)}`);
      }
      expect(err.name).toBe('ReadonlyStateError');
      expect(err.message).toContain("Cannot set 'b'");
    });

    it('leaves the backing record unchanged', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      expect(() => state.set('b', 2)).toThrow();

      expect(backing).toEqual({a: 1});
      expect(state.toRecord()).toEqual({a: 1});
      expect(state.hasDelta()).toBe(false);
    });

    it('keeps the offending value out of the message', () => {
      const state = new ReadonlyState({});

      const err = thrownBy(() => state.set('token', 'super-secret'));

      if (!isReadonlyStateError(err)) {
        expect.fail(`expected a ReadonlyStateError, got ${String(err)}`);
      }
      expect(err.message).not.toContain('super-secret');
    });
  });

  describe('update', () => {
    it('throws ReadonlyStateError naming every key', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      const err = thrownBy(() => state.update({b: 2, c: 3}));

      if (!isReadonlyStateError(err)) {
        expect.fail(`expected a ReadonlyStateError, got ${String(err)}`);
      }
      expect(err.message).toContain("Cannot update 'b', 'c'");
    });

    it('leaves the backing record unchanged', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      expect(() => state.update({b: 2})).toThrow();

      expect(backing).toEqual({a: 1});
      expect(state.toRecord()).toEqual({a: 1});
      expect(state.hasDelta()).toBe(false);
    });
  });

  describe('reads', () => {
    it('reads through to the backing record', () => {
      const backing: Record<string, unknown> = {a: 1, nested: {n: 2}};
      const state = new ReadonlyState(backing);

      expect(state.get<number>('a')).toBe(1);
      expect(state.get<number>('missing', 7)).toBe(7);
      expect(state.get<number>('missing')).toBeUndefined();
      expect(state.has('a')).toBe(true);
      expect(state.has('missing')).toBe(false);
      expect(state.toRecord()).toEqual(backing);
    });

    it('stays live when the backing record changes', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      backing['a'] = 2;
      backing['b'] = 3;

      expect(state.get<number>('a')).toBe(2);
      expect(state.has('b')).toBe(true);
    });

    it('returns a copy from toRecord', () => {
      const backing: Record<string, unknown> = {a: 1};
      const state = new ReadonlyState(backing);

      const record = state.toRecord();
      record['a'] = 99;
      record['b'] = 2;

      expect(backing).toEqual({a: 1});
    });
  });

  describe('isReadonlyStateError', () => {
    it('returns false for a plain Error and for a non-error value', () => {
      expect(isReadonlyStateError(new Error('nope'))).toBe(false);
      expect(isReadonlyStateError('ReadonlyStateError')).toBe(false);
    });
  });
});
