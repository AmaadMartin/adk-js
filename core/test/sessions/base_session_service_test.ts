/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mergeStates} from '../../src/sessions/base_session_service.js';

/**
 * A `'__proto__': value` pair in an object literal invokes the prototype
 * setter instead of creating an own key, so it cannot express what an attacker
 * actually sends. `JSON.parse` is what the dev server does with a request
 * body, and it does produce an own `__proto__` key.
 */
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

describe('mergeStates', () => {
  const POLLUTED_KEYS = ['isAdmin'];

  const clearPollution = () => {
    for (const key of POLLUTED_KEYS) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  };

  beforeEach(clearPollution);
  afterEach(clearPollution);

  it('returns a null-prototype map when called with no arguments', () => {
    expect(Object.getPrototypeOf(mergeStates())).toBeNull();
  });

  it('returns a null-prototype map for a plain session state', () => {
    const merged = mergeStates({}, {}, {name: 'Alice'});

    expect(Object.getPrototypeOf(merged)).toBeNull();
  });

  it('returns a null-prototype map for an already null-prototype session state', () => {
    const sessionState: Record<string, unknown> = Object.create(null);
    sessionState['name'] = 'Alice';

    expect(Object.getPrototypeOf(mergeStates({}, {}, sessionState))).toBeNull();
  });

  it('merges app and user state under their prefixes without changing content', () => {
    const merged = mergeStates(
      {theme: 'dark'},
      {locale: 'en-GB'},
      {name: 'Alice'},
    );

    expect(merged).toEqual({
      name: 'Alice',
      [`${State.APP_PREFIX}theme`]: 'dark',
      [`${State.USER_PREFIX}locale`]: 'en-GB',
    });
    expect(Object.getPrototypeOf(merged)).toBeNull();
  });

  it('does not expose inherited Object.prototype members as state', () => {
    const merged = mergeStates({}, {}, {name: 'Alice'});

    expect('toString' in merged).toBe(false);
    expect(merged['constructor']).toBeUndefined();
  });

  it('keeps an own __proto__ session state key as an own data property', () => {
    const merged = mergeStates(
      {},
      {},
      parseBody('{"__proto__": {"isAdmin": true}, "foo": "bar"}'),
    );

    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual(
      {
        isAdmin: true,
      },
    );
    expect(merged['foo']).toBe('bar');
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('deep-clones the session state so the result is not aliased to the input', () => {
    const sessionState = {nested: {count: 1}};
    const merged = mergeStates({}, {}, sessionState);

    (merged['nested'] as {count: number}).count = 2;

    expect(sessionState.nested.count).toBe(1);
  });
});
