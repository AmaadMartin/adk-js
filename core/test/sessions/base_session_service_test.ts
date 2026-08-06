/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mergeStates, splitStateDelta} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('splitStateDelta', () => {
  it('routes each key by prefix and drops temporary keys', () => {
    expect(
      splitStateDelta({
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

  it('returns empty buckets for undefined state', () => {
    expect(splitStateDelta(undefined)).toEqual({
      app: {},
      user: {},
      session: {},
    });
  });

  it('strips only the leading prefix', () => {
    expect(splitStateDelta({'app:app:nested': 1})).toEqual({
      app: {'app:nested': 1},
      user: {},
      session: {},
    });
  });

  it('round-trips through mergeStates for non-temporary keys', () => {
    const state = {'app:theme': 'dark', 'user:locale': 'en', turn: 2};
    const {app, user, session} = splitStateDelta(state);

    expect(mergeStates(app, user, session)).toEqual(state);
  });
});
