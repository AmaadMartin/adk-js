/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State, applyStateDelta, extractStateDelta} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {recordStateWrite} from '../../src/sessions/state_write_order.js';

// A `'__proto__': value` pair in an object literal invokes the prototype
// setter instead of creating an own key, so it cannot express what an attacker
// actually sends. `JSON.parse` is what the dev server does with a request
// body, and it does produce an own `__proto__` key.
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

describe('extractStateDelta', () => {
  it('splits the state by scope and strips the prefixes', () => {
    const deltas = extractStateDelta({
      [`${State.APP_PREFIX}a`]: 'av',
      [`${State.USER_PREFIX}u`]: 'uv',
      [`${State.TEMP_PREFIX}t`]: 'tv',
      sk: 'sv',
    });

    expect(deltas.app).toEqual({a: 'av'});
    expect(deltas.user).toEqual({u: 'uv'});
    expect(deltas.session).toEqual({sk: 'sv'});
  });

  it('returns three empty buckets for an empty state', () => {
    const deltas = extractStateDelta({});

    expect(deltas.app).toEqual({});
    expect(deltas.user).toEqual({});
    expect(deltas.session).toEqual({});
  });

  it('strips only the leading prefix', () => {
    const deltas = extractStateDelta({
      [`${State.APP_PREFIX}x${State.APP_PREFIX}y`]: 'v',
    });

    expect(deltas.app).toEqual({[`x${State.APP_PREFIX}y`]: 'v'});
  });

  it('keeps a __proto__ key as an own property of its bucket', () => {
    const deltas = extractStateDelta(
      parseBody(`{"${State.USER_PREFIX}__proto__": {"isAdmin": true}}`),
    );

    expect(Object.keys(deltas.user)).toEqual(['__proto__']);
    expect(deltas.user['__proto__']).toEqual({isAdmin: true});
  });
});

describe('applyStateDelta', () => {
  it('commits every non-temp entry', () => {
    const state: Record<string, unknown> = {existing: 'old'};

    applyStateDelta(state, {
      existing: 'new',
      added: 'v',
      [`${State.TEMP_PREFIX}t`]: 'tv',
    });

    expect(state).toEqual({existing: 'new', added: 'v'});
  });

  it('stores a __proto__ entry as an own property', () => {
    const state: Record<string, unknown> = {};

    applyStateDelta(state, parseBody('{"__proto__": {"isAdmin": true}}'));

    expect(Object.keys(state)).toEqual(['__proto__']);
    expect(new State(state).get('isAdmin')).toBeUndefined();
  });

  it('skips an entry a newer write already superseded', () => {
    const state: Record<string, unknown> = {};
    const delta: Record<string, unknown> = {attempts: 0};
    recordStateWrite(state, delta, 'attempts');
    state['attempts'] = 1;
    recordStateWrite(state, undefined, 'attempts');

    applyStateDelta(state, delta);

    expect(state['attempts']).toBe(1);
  });
});
