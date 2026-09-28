/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {State} from '../../src/sessions/state.js';
import {shouldApplyDeltaWrite} from '../../src/sessions/state_write_order.js';

describe('State', () => {
  describe('update', () => {
    it('preserves object references for delta and value', () => {
      const delta: Record<string, unknown> = {};
      const value: Record<string, unknown> = {};
      const state = new State(value, delta);

      const updates = {key: 'newValue'};
      state.update(updates);

      // Verify that the object passed to the constructor is mutated,
      // which confirms the reference was preserved.
      expect(delta['key']).toBe('newValue');
      expect(value['key']).toBe('newValue');

      // Verify state.get returns the updated value
      expect(state.get('key')).toBe('newValue');
    });

    it('handles multiple updates correctly', () => {
      const delta: Record<string, unknown> = {};
      const value: Record<string, unknown> = {};
      const state = new State(value, delta);

      state.update({key1: 'value1'});
      state.update({key2: 'value2', key1: 'value1_updated'});

      expect(delta['key1']).toBe('value1_updated');
      expect(delta['key2']).toBe('value2');
      expect(value['key1']).toBe('value1_updated');
      expect(value['key2']).toBe('value2');
    });
  });

  describe('setDefault', () => {
    it('writes the default through when the key is absent', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      expect(state.setDefault('attempts', 0)).toBe(0);

      expect(value['attempts']).toBe(0);
      expect(delta['attempts']).toBe(0);
      expect(state.hasDelta()).toBe(true);
    });

    it('returns the existing value and writes nothing', () => {
      const value: Record<string, unknown> = {key: 'existing'};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      expect(state.setDefault('key', 'fallback')).toBe('existing');

      expect(value['key']).toBe('existing');
      expect(state.hasDelta()).toBe(false);
    });

    it('prefers a pending delta over the committed value', () => {
      const state = new State({key: 'committed'}, {key: 'pending'});

      expect(state.setDefault('key', 'fallback')).toBe('pending');
    });

    it('keeps a falsy existing value', () => {
      for (const stored of [0, '', false, null]) {
        const delta: Record<string, unknown> = {};
        const state = new State({key: stored}, delta);

        expect(state.setDefault('key', 'fallback')).toBe(stored);
        expect(state.hasDelta()).toBe(false);
      }
    });

    it('treats a key explicitly holding undefined as present', () => {
      const state = new State({key: undefined}, {});

      expect(state.setDefault('key', 'fallback')).toBeUndefined();
      expect(state.hasDelta()).toBe(false);
    });

    it('stamps the write so a newer write is not rolled back', () => {
      const value: Record<string, unknown> = {};
      const seeded: Record<string, unknown> = {};
      new State(value, seeded).setDefault('attempts', 0);

      // A newer writer over the same value map supersedes the seeded delta.
      new State(value, {}).set('attempts', 1);

      expect(shouldApplyDeltaWrite(value, seeded, 'attempts')).toBe(false);
    });
  });
});
