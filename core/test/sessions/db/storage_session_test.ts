/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python's `tests/unittests/sessions/test_storage_session.py`.
 * Each test keeps the reference test's name.
 *
 * The reference parametrizes over the v0 and v1 schemas, which declare two
 * different `StorageSession` classes. adk-js has one, shared by both entity
 * sets, so there is nothing to parametrize over.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createEvent} from '../../../src/events/event.js';
import {StorageSession, toSession} from '../../../src/sessions/db/schema.js';

/** The instant the reference stores, to the millisecond a `Date` can hold. */
const UPDATE_TIME = new Date('2026-01-02T03:04:05.123Z');

function storageSession(updateTime: Date): StorageSession {
  const row = new StorageSession();
  row.appName = 'my_app';
  row.userId = 'u1';
  row.id = 's1';
  row.state = {};
  row.updateTime = updateTime;
  return row;
}

describe('toSession', () => {
  it('test_to_session_without_arguments_yields_empty_state_and_events', () => {
    const session = toSession(storageSession(UPDATE_TIME), {state: {}});

    expect(session.appName).toBe('my_app');
    expect(session.userId).toBe('u1');
    expect(session.id).toBe('s1');
    expect(session.state).toEqual({});
    expect(session.events).toEqual([]);
  });

  it('test_to_session_carries_supplied_state_and_events', () => {
    const event = createEvent({invocationId: 'inv1', author: 'user'});

    const session = toSession(storageSession(UPDATE_TIME), {
      state: {k: 'v'},
      events: [event],
    });

    expect(session.state).toEqual({k: 'v'});
    expect(session.events.map((e) => e.invocationId)).toEqual(['inv1']);
  });

  it('test_to_session_reads_naive_update_time_as_utc', () => {
    const previousTimezone = process.env.TZ;
    // Pin a non-UTC zone, so reading the stored instant as local time would
    // produce a different epoch than reading it as UTC.
    process.env.TZ = 'America/Los_Angeles';
    try {
      const session = toSession(storageSession(UPDATE_TIME), {state: {}});

      expect(session.lastUpdateTime).toBe(UPDATE_TIME.getTime());
      expect(session.storageUpdateMarker).toBe('2026-01-02T03:04:05.123Z');
    } finally {
      process.env.TZ = previousTimezone;
    }
  });

  it('test_to_session_normalizes_aware_update_time_marker_to_utc', () => {
    const offsetTime = new Date('2026-01-02T03:04:05.123+05:00');

    const session = toSession(storageSession(offsetTime), {state: {}});

    expect(session.lastUpdateTime).toBe(offsetTime.getTime());
    expect(session.storageUpdateMarker).toBe('2026-01-01T22:04:05.123Z');
  });

  it('returns the row timestamp in milliseconds', () => {
    const session = toSession(storageSession(UPDATE_TIME), {state: {}});

    expect(session.lastUpdateTime).toBe(UPDATE_TIME.getTime());
  });
});

describe('toSession update marker', () => {
  let previousTimezone: string | undefined;

  beforeEach(() => {
    previousTimezone = process.env.TZ;
  });

  afterEach(() => {
    process.env.TZ = previousTimezone;
  });

  it('renders the same marker whatever the local zone is', () => {
    process.env.TZ = 'America/Los_Angeles';
    const inLosAngeles = toSession(storageSession(UPDATE_TIME), {
      state: {},
    }).storageUpdateMarker;
    process.env.TZ = 'Asia/Tokyo';
    const inTokyo = toSession(storageSession(UPDATE_TIME), {
      state: {},
    }).storageUpdateMarker;

    expect(inLosAngeles).toBe(inTokyo);
    expect(inTokyo).toBe('2026-01-02T03:04:05.123Z');
  });
});
