/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {extractStateDelta, makeJsonSafeState} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

describe('extractStateDelta', () => {
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
});

describe('makeJsonSafeState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coerces a value JSON cannot represent and warns once', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const safe = makeJsonSafeState({callback: () => 1, ok: 2});

    expect(typeof safe['callback']).toBe('string');
    expect(safe['ok']).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
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
});
