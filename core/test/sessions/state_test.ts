/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isState, State} from '../../src/sessions/state.js';

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
});

describe('isState', () => {
  it('accepts a State', () => {
    expect(isState(new State())).toBe(true);
  });

  it('accepts a duck-typed state-like object', () => {
    const stateLike = {
      get: () => undefined,
      set: () => {},
      has: () => false,
    };

    expect(isState(stateLike)).toBe(true);
  });

  it.each([
    ['a plain object', {}],
    ['an object missing has', {get: () => undefined, set: () => {}}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'state'],
    ['a number', 1],
  ])('rejects %s', (_name, value) => {
    expect(isState(value)).toBe(false);
  });
});
