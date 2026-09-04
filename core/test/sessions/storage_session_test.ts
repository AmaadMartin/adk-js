/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/sessions/test_storage_session.py` from
 * `google/adk-python`, read at `main`. The reference file is parametrised over
 * the v0 and v1 schemas; adk-js declares one `StorageSession` that both
 * layouts share, so each reference test ports to a single case.
 */

import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {StorageSession} from '../../src/sessions/db/schema.js';

/** The instant the reference file stores, to the millisecond a `Date` holds. */
const UPDATE_TIME = new Date('2026-01-02T03:04:05.123Z');

/** The same instant, written in a zone five hours ahead of UTC. */
const OFFSET_UPDATE_TIME = new Date('2026-01-02T08:04:05.123+05:00');

function storageSession(updateTime: Date): StorageSession {
  const session = new StorageSession();
  session.appName = 'my_app';
  session.userId = 'u1';
  session.id = 's1';
  session.state = {};
  session.updateTime = updateTime;
  return session;
}

describe('StorageSession.toSession', () => {
  it('to_session_without_arguments_yields_empty_state_and_events', () => {
    const session = storageSession(UPDATE_TIME).toSession();

    expect(session.appName).toBe('my_app');
    expect(session.userId).toBe('u1');
    expect(session.id).toBe('s1');
    expect(session.state).toEqual({});
    expect(session.events).toEqual([]);
  });

  it('to_session_carries_supplied_state_and_events', () => {
    const event = createEvent({invocationId: 'inv1', author: 'user'});

    const session = storageSession(UPDATE_TIME).toSession({k: 'v'}, [event]);

    expect(session.state).toEqual({k: 'v'});
    expect(session.events.map((e) => e.invocationId)).toEqual(['inv1']);
  });

  /**
   * Adapted from `test_to_session_reads_naive_update_time_as_utc`. A JavaScript
   * `Date` is an absolute instant, so there is no naive reading to guard
   * against and no local-zone hazard to pin. The assertions state adk-js's
   * behaviour instead: milliseconds since the epoch, and an ISO-8601 marker.
   */
  it('to_session_reads_update_time_as_an_absolute_instant', () => {
    const session = storageSession(UPDATE_TIME).toSession();

    expect(session.lastUpdateTime).toBe(UPDATE_TIME.getTime());
    expect(session.storageUpdateMarker).toBe('2026-01-02T03:04:05.123Z');
  });

  /**
   * Adapted from `test_to_session_normalizes_aware_update_time_marker_to_utc`.
   * `toISOString` is UTC by construction, so an offset written into the source
   * value normalises without any extra step.
   */
  it('to_session_normalizes_an_offset_update_time_marker_to_utc', () => {
    const session = storageSession(OFFSET_UPDATE_TIME).toSession();

    expect(session.lastUpdateTime).toBe(OFFSET_UPDATE_TIME.getTime());
    expect(session.storageUpdateMarker).toBe('2026-01-02T03:04:05.123Z');
  });

  it('reports the update timestamp in milliseconds, not seconds', () => {
    expect(storageSession(UPDATE_TIME).getUpdateTimestamp()).toBe(
      UPDATE_TIME.getTime(),
    );
    expect(storageSession(new Date(1500)).getUpdateTimestamp()).toBe(1500);
  });
});
