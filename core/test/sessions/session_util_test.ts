/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  decodeModel,
  extractJsonSafeStateDelta,
  extractStateDelta,
  makeJsonSafeState,
} from '../../src/sessions/session_util.js';
import {logger} from '../../src/utils/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decodeModel', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the string a session store persisted for SQL NULL', 'null'],
    ['a plain string', 's'],
    ['a number', 0],
    ['a boolean', false],
    ['an array', []],
  ])('drops %s', (_, value) => {
    expect(decodeModel(value)).toBeUndefined();
  });

  it('returns an object payload unchanged', () => {
    const payload = {a: 1};

    expect(decodeModel<{a: number}>(payload)).toBe(payload);
  });

  it('returns an empty object, which is a valid payload', () => {
    expect(decodeModel({})).toEqual({});
  });
});

describe('extractStateDelta', () => {
  it('splits the app, user and session scopes and strips the prefixes', () => {
    const delta = extractStateDelta({
      [`${State.APP_PREFIX}theme`]: 'dark',
      [`${State.USER_PREFIX}locale`]: 'en',
      'turns': 2,
    });

    expect(delta.app).toEqual({theme: 'dark'});
    expect(delta.user).toEqual({locale: 'en'});
    expect(delta.session).toEqual({turns: 2});
  });

  it('splits keys by their scope prefix', () => {
    const delta = extractStateDelta({
      'app:tier': 'gold',
      'user:locale': 'en-GB',
      topic: 'weather',
    });

    expect(delta.app).toEqual({tier: 'gold'});
    expect(delta.user).toEqual({locale: 'en-GB'});
    expect(delta.session).toEqual({topic: 'weather'});
  });

  it('drops a temp entry, which is never persisted', () => {
    const delta = extractStateDelta({
      [`${State.TEMP_PREFIX}scratch`]: 'x',
      'kept': 'y',
    });

    expect(delta.session).toEqual({kept: 'y'});
  });

  it('drops temp keys from every bucket', () => {
    const delta = extractStateDelta({'temp:scratch': 1, kept: 2});

    expect(delta.session).toEqual({kept: 2});
    expect(delta.app).toEqual({});
    expect(delta.user).toEqual({});
  });

  it('returns three empty buckets for an empty state', () => {
    const delta = extractStateDelta({});

    expect(delta).toEqual({app: {}, user: {}, session: {}});
  });

  it('defaults to an empty state when none is given', () => {
    expect(extractStateDelta()).toEqual({app: {}, user: {}, session: {}});
  });

  it('strips only the leading prefix from a key', () => {
    const delta = extractStateDelta({'app:app:nested': 1});

    expect(delta.app).toEqual({'app:nested': 1});
  });

  it('stores a __proto__ key as an own property of the bucket', () => {
    const state: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    );

    const delta = extractStateDelta(state);

    expect(Object.keys(delta.session)).toEqual(['__proto__']);
    expect({}).not.toHaveProperty('polluted');
  });

  it('returns null-prototype buckets', () => {
    const delta = extractStateDelta({});

    expect(Object.getPrototypeOf(delta.app)).toBeNull();
    expect(Object.getPrototypeOf(delta.user)).toBeNull();
    expect(Object.getPrototypeOf(delta.session)).toBeNull();
  });
});

describe('makeJsonSafeState', () => {
  it('coerces a value JSON cannot represent and warns once', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({retries: 3n, onDone: () => {}});

    expect(safe).toEqual({retries: '3', onDone: '[Function: onDone]'});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('coerces a callback and keeps the value beside it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({callback: () => 1, ok: 2});

    expect(typeof safe['callback']).toBe('string');
    expect(safe['ok']).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never logs the state value itself', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    makeJsonSafeState({secret: 4321n});

    expect(warn.mock.calls.flat().join(' ')).not.toContain('4321');
  });

  it('stays quiet when every value already survives JSON', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(makeJsonSafeState({a: 1, b: [null, 'x']})).toEqual({
      a: 1,
      b: [null, 'x'],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for state JSON already represents', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({at: new Date(0), n: 1});

    expect(safe).toEqual({at: '1970-01-01T00:00:00.000Z', n: 1});
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns state that JSON.stringify accepts', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({big: 7n});

    expect(JSON.parse(JSON.stringify(safe))).toEqual({big: '7'});
  });

  it('keeps a state key named toJSON from swallowing the whole map', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({toJSON: () => 'gone', kept: 1});

    expect(safe['kept']).toBe(1);
    expect(safe['toJSON']).toBe('[Function: toJSON]');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns a null-prototype map', () => {
    expect(Object.getPrototypeOf(makeJsonSafeState({}))).toBeNull();
  });
});

describe('extractJsonSafeStateDelta', () => {
  it('coerces and splits in one pass', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const delta = extractJsonSafeStateDelta({
      [`${State.APP_PREFIX}build`]: 12n,
      [`${State.USER_PREFIX}seen`]: new Date('2026-01-02T03:04:05.000Z'),
      [`${State.TEMP_PREFIX}scratch`]: 'x',
      'turns': 2,
    });

    expect(delta.app).toEqual({build: '12'});
    expect(delta.user).toEqual({seen: '2026-01-02T03:04:05.000Z'});
    expect(delta.session).toEqual({turns: 2});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves the caller state untouched', () => {
    const state = {counts: [1, 2]};

    const delta = extractJsonSafeStateDelta(state);
    (delta.session['counts'] as number[]).push(3);

    expect(state.counts).toEqual([1, 2]);
  });
});
