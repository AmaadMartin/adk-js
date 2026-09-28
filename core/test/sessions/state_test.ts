/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {State} from '../../src/sessions/state.js';

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

  describe('getDelta', () => {
    it('returns an empty object for a fresh state', () => {
      expect(new State().getDelta()).toEqual({});
    });

    it('returns the keys written through set', () => {
      const state = new State();

      state.set('key1', 'value1');
      state.set('key2', {nested: true});

      expect(state.getDelta()).toEqual({key1: 'value1', key2: {nested: true}});
    });

    it('returns a copy that does not write back into the state', () => {
      const state = new State();
      state.set('key', 'value');

      const delta = state.getDelta();
      delta['key'] = 'mutated';
      delta['added'] = 'new';

      expect(state.getDelta()).toEqual({key: 'value'});
      expect(state.get('key')).toBe('value');
    });

    it('omits keys that exist only in the value', () => {
      const state = new State({existing: 'fromValue'});

      state.set('written', 'fromSet');

      expect(state.getDelta()).toEqual({written: 'fromSet'});
    });
  });
});
