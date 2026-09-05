/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createEventActions} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  extractJsonSafeStateDelta,
  makeDeltaJsonSafe,
} from '../../src/sessions/session_state_utils.js';

describe('extractJsonSafeStateDelta', () => {
  it('splits a delta by prefix and strips it', () => {
    expect(
      extractJsonSafeStateDelta({
        'app:theme': 'dark',
        'user:locale': 'en-US',
        'draft': 'hello',
      }),
    ).toEqual({
      app: {theme: 'dark'},
      user: {locale: 'en-US'},
      session: {draft: 'hello'},
    });
  });

  it('drops temp: keys and keeps null values', () => {
    expect(
      extractJsonSafeStateDelta({'temp:scratch': 1, cleared: null}),
    ).toEqual({app: {}, user: {}, session: {cleared: null}});
  });

  it('returns null-prototype maps', () => {
    const deltas = extractJsonSafeStateDelta({});
    expect(Object.getPrototypeOf(deltas.app)).toBeNull();
    expect(Object.getPrototypeOf(deltas.user)).toBeNull();
    expect(Object.getPrototypeOf(deltas.session)).toBeNull();
  });

  it('does not re-parent a scope through a __proto__ key', () => {
    // `JSON.parse` makes `__proto__` an own key, so a request body can carry
    // one.
    const deltas = extractJsonSafeStateDelta(
      JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'),
    );
    expect(deltas.session['ok']).toBe(1);
    expect('polluted' in {}).toBe(false);
  });

  it('replaces a value no JSON column can hold with its string form', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(
      extractJsonSafeStateDelta({
        'app:big': 10n,
        'user:cycle': cyclic,
        'fn': () => 1,
        'kept': {a: [1, false, null]},
      }),
    ).toEqual({
      app: {big: '10'},
      user: {cycle: '[object Object]'},
      session: {fn: '() => 1', kept: {a: [1, false, null]}},
    });
  });
});

describe('makeDeltaJsonSafe', () => {
  it('coerces the event delta in place, leaving safe values alone', () => {
    const event = createEvent({
      author: 'user',
      actions: createEventActions({stateDelta: {big: 10n, ok: 'v'}}),
    });

    makeDeltaJsonSafe(event);

    expect(event.actions.stateDelta).toEqual({big: '10', ok: 'v'});
  });

  it('leaves an empty delta alone', () => {
    const event = createEvent({author: 'user'});
    makeDeltaJsonSafe(event);
    expect(event.actions.stateDelta).toEqual({});
  });
});
