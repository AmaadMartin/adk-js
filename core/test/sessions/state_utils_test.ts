/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {extractStateDelta, mergeStates} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('extractStateDelta', () => {
  it('returns empty buckets for an empty state', () => {
    expect(extractStateDelta({})).toEqual({app: {}, user: {}, session: {}});
  });

  it('returns empty buckets for undefined state', () => {
    expect(extractStateDelta(undefined)).toEqual({
      app: {},
      user: {},
      session: {},
    });
  });

  it('routes an app-prefixed key to the app bucket with the prefix stripped', () => {
    expect(extractStateDelta({'app:theme': 'dark'})).toEqual({
      app: {theme: 'dark'},
      user: {},
      session: {},
    });
  });

  it('routes a user-prefixed key to the user bucket with the prefix stripped', () => {
    expect(extractStateDelta({'user:lang': 'en'})).toEqual({
      app: {},
      user: {lang: 'en'},
      session: {},
    });
  });

  it('routes an unprefixed key to the session bucket verbatim', () => {
    expect(extractStateDelta({turn: 3})).toEqual({
      app: {},
      user: {},
      session: {turn: 3},
    });
  });

  it('drops a temporary key from every bucket', () => {
    expect(extractStateDelta({'temp:scratch': 'ignore_me'})).toEqual({
      app: {},
      user: {},
      session: {},
    });
  });

  it('routes each key by prefix and drops temporary keys', () => {
    expect(
      extractStateDelta({
        'app:theme': 'dark',
        'user:locale': 'en',
        'temp:scratch': 1,
        turn: 2,
      }),
    ).toEqual({
      app: {theme: 'dark'},
      user: {locale: 'en'},
      session: {turn: 2},
    });
  });

  it('does not mutate the input and allocates fresh buckets', () => {
    const state = Object.freeze({'app:theme': 'dark', turn: 3});

    const deltas = extractStateDelta(state);

    expect(state).toEqual({'app:theme': 'dark', turn: 3});
    expect(deltas.app).not.toBe(state);
    expect(deltas.user).not.toBe(state);
    expect(deltas.session).not.toBe(state);
  });

  it('keeps an empty remainder when the key is only a prefix', () => {
    expect(extractStateDelta({'app:': 1})).toEqual({
      app: {'': 1},
      user: {},
      session: {},
    });
  });

  it('strips only the leading prefix when a prefix repeats', () => {
    expect(extractStateDelta({'app:app:nested': 1})).toEqual({
      app: {'app:nested': 1},
      user: {},
      session: {},
    });
  });

  it('strips only the leading prefix when another prefix follows it', () => {
    expect(extractStateDelta({'app:user:x': 1})).toEqual({
      app: {'user:x': 1},
      user: {},
      session: {},
    });
  });

  it('carries object values over by reference', () => {
    const config = {a: 1};

    expect(extractStateDelta({'app:cfg': config}).app['cfg']).toBe(config);
  });

  it('round-trips through mergeStates for non-temporary keys', () => {
    const state = {'app:theme': 'dark', 'user:locale': 'en', turn: 2};

    const {app, user, session} = extractStateDelta(state);

    expect(mergeStates(app, user, session)).toEqual(state);
  });

  it('gives every bucket a null prototype', () => {
    const {app, user, session} = extractStateDelta({});

    expect(Object.getPrototypeOf(app)).toBeNull();
    expect(Object.getPrototypeOf(user)).toBeNull();
    expect(Object.getPrototypeOf(session)).toBeNull();
  });

  it('keeps a __proto__ key as an own property in each bucket', () => {
    const value = {baseUrl: 'https://evil.test'};

    // A literal `'__proto__': value` pair invokes the inherited setter rather
    // than creating an own key, so the session bucket is fed through JSON.
    const {app, user} = extractStateDelta({
      'app:__proto__': value,
      'user:__proto__': value,
    });
    const {session} = extractStateDelta(
      JSON.parse('{"__proto__": {"baseUrl": "https://evil.test"}}') as Record<
        string,
        unknown
      >,
    );

    // Reading `bucket['__proto__']` also answers through the inherited getter
    // on a re-parented bucket, so assert the own property instead.
    expect(Object.hasOwn(app, '__proto__')).toBe(true);
    expect(Object.hasOwn(user, '__proto__')).toBe(true);
    expect(Object.hasOwn(session, '__proto__')).toBe(true);
    expect(app['__proto__']).toBe(value);
    expect(user['__proto__']).toBe(value);
    expect(session['__proto__']).toEqual(value);
  });
});
