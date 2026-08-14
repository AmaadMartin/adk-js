/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {State} from '../../src/sessions/state.js';

const POLLUTED_KEYS = ['polluted'];

const clearPollution = () => {
  for (const key of POLLUTED_KEYS) {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
};

// A `'__proto__': value` pair in an object literal invokes the prototype setter
// instead of creating an own key, so it cannot express what an attacker
// actually sends. `JSON.parse` is what the dev server does with a request body,
// and it does produce an own `__proto__` key.
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

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

  describe('inherited keys', () => {
    it('does not report an inherited key as present', () => {
      expect(new State().has('toString')).toBe(false);
      expect(new State().has('constructor')).toBe(false);
      expect(new State({}, {}).has('toString')).toBe(false);
      expect(new State({}, {}).has('constructor')).toBe(false);
      expect(new State(Object.create(null)).has('toString')).toBe(false);
      expect(new State(Object.create(null)).has('constructor')).toBe(false);
    });

    it('does not return an inherited value from get', () => {
      expect(new State().get('constructor')).toBeUndefined();
      expect(new State().get('toString')).toBeUndefined();
      expect(new State({}, {}).get('constructor')).toBeUndefined();
      expect(new State(Object.create(null)).get('toString')).toBeUndefined();
    });

    it('falls back to the default value for an inherited key', () => {
      expect(new State().get('toString', 'fallback')).toBe('fallback');
      expect(new State({}, {}).get('constructor', 'fallback')).toBe('fallback');
    });

    it('still stores an own key that shadows a prototype member', () => {
      const state = new State();
      state.set('constructor', 1);

      expect(state.get('constructor')).toBe(1);
      expect(state.has('constructor')).toBe(true);
      expect(state.toRecord()['constructor']).toBe(1);
    });
  });

  describe('__proto__ writes', () => {
    beforeEach(clearPollution);
    afterEach(clearPollution);

    it('stores __proto__ as an own key on both caller maps', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);
      const payload = {polluted: true};

      state.set('__proto__', payload);

      expect(Object.hasOwn(value, '__proto__')).toBe(true);
      expect(Object.hasOwn(delta, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(delta)).toBe(Object.prototype);
      expect(state.get('__proto__')).toBe(payload);
      expect(state.has('__proto__')).toBe(true);
      expect(state.hasDelta()).toBe(true);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('stores __proto__ on a default-constructed state', () => {
      const state = new State();
      const payload = {polluted: true};

      state.set('__proto__', payload);

      expect(state.get('__proto__')).toBe(payload);
      expect(state.has('__proto__')).toBe(true);
      expect(state.hasDelta()).toBe(true);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('writes an enumerable, writable, configurable data property', () => {
      const value: Record<string, unknown> = {};
      const state = new State(value, {});
      const payload = {polluted: true};

      state.set('__proto__', payload);

      expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
        value: payload,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });

    it('stores a __proto__ entry that arrives through update', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      state.update(parseBody('{"__proto__":{"polluted":true},"ok":1}'));

      expect(Object.hasOwn(value, '__proto__')).toBe(true);
      expect(Object.hasOwn(delta, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(delta)).toBe(Object.prototype);
      expect(state.get('__proto__')).toEqual({polluted: true});
      expect(state.get('ok')).toBe(1);
      expect(state.hasDelta()).toBe(true);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('stores a __proto__ entry from update on a default-constructed state', () => {
      const state = new State();

      state.update(parseBody('{"__proto__":{"polluted":true},"ok":1}'));

      expect(state.has('__proto__')).toBe(true);
      expect(state.get('__proto__')).toEqual({polluted: true});
      expect(state.get('ok')).toBe(1);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('carries the __proto__ entry through toRecord', () => {
      const state = new State({}, {});

      state.update(parseBody('{"__proto__":{"polluted":true},"ok":1}'));
      const record = state.toRecord();

      expect(Object.hasOwn(record, '__proto__')).toBe(true);
      expect(record['__proto__']).toEqual({polluted: true});
      expect(record['ok']).toBe(1);
      expect(Object.hasOwn(record, 'polluted')).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  describe('ordinary keys', () => {
    it('reads back a key written by set', () => {
      const state = new State();

      state.set('k', 'v');

      expect(state.get('k')).toBe('v');
      expect(state.has('k')).toBe(true);
      expect(state.hasDelta()).toBe(true);
      expect(state.toRecord()).toEqual({k: 'v'});
    });

    it('reads a key that only the value map holds', () => {
      const state = new State({fromValue: 1}, {});

      expect(state.get('fromValue')).toBe(1);
      expect(state.has('fromValue')).toBe(true);
      expect(state.hasDelta()).toBe(false);
    });

    it('prefers the delta value over the value map', () => {
      const state = new State({key: 'old'}, {key: 'new'});

      expect(state.get('key')).toBe('new');
    });

    it('returns undefined or the default value for an absent key', () => {
      const state = new State({}, {});

      expect(state.get('missing')).toBeUndefined();
      expect(state.get('missing', 'fallback')).toBe('fallback');
      expect(state.has('missing')).toBe(false);
    });

    it('preserves object references for delta and value on set', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      state.set('key', 'newValue');

      expect(value['key']).toBe('newValue');
      expect(delta['key']).toBe('newValue');
      expect(state.get('key')).toBe('newValue');
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
