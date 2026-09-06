/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference suite for `FirestoreSessionService`, ported from
 * `google/adk-python`,
 * `tests/unittests/integrations/firestore/test_firestore_session_service.py`,
 * read at `main`.
 *
 * Each `it` keeps the Python test's name verbatim so a reviewer can find the
 * original. The reference leans on `MagicMock`'s auto-chaining; TypeScript has
 * no equivalent, so these run against the in-memory double in
 * `firestore_test_doubles.ts`, which stores what the service writes and hands
 * it back. Three assertions differ from the reference on purpose, and each
 * says so where it is made: time is epoch milliseconds here rather than
 * seconds, an absent session resolves `undefined` rather than `None`, and
 * `temp:` keys do not survive in memory.
 */

import {FieldValue} from '@google-cloud/firestore';
import {
  AlreadyExistsError,
  createEvent,
  createSession,
  Event,
  LogLevel,
  Session,
  SessionNotFoundError,
  setLogLevel,
  StaleSessionError,
} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  appStatePath,
  eventPath,
  FakeFirestore,
  sessionPath,
  userStatePath,
} from './firestore_test_doubles.js';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

let client: FakeFirestore;
let service: FirestoreSessionService;

// The repo's global setup raises the level in its own process, not in the
// worker that runs this file, so the coercion warning would otherwise reach
// the CI log.
beforeAll(() => {
  setLogLevel(LogLevel.ERROR);
});

beforeEach(() => {
  client = new FakeFirestore();
  service = new FirestoreSessionService({client});
});

/** Reads a document the test requires to exist. */
function storedDoc(path: string): Record<string, unknown> {
  const doc = client.read(path);
  if (!doc) {
    expect.fail(`no document stored at ${path}`);
  }
  return doc;
}

/** Reads the JSON-encoded session state out of a stored session document. */
function storedState(path: string): Record<string, unknown> {
  const raw = storedDoc(path)['state'];
  if (typeof raw !== 'string') {
    expect.fail(`session state at ${path} is not a JSON string`);
  }
  return JSON.parse(raw);
}

/** Seeds a session document the service can append to. */
function seedSession(overrides: Record<string, unknown> = {}): void {
  client.put(sessionPath(APP_NAME, USER_ID, SESSION_ID), {
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
    state: '{}',
    revision: 0,
    ...overrides,
  });
}

/** Builds the in-memory session handed to `appendEvent`. */
function localSession(state: Record<string, unknown> = {}): Session {
  return createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
    state,
  });
}

function eventWithDelta(stateDelta: Record<string, unknown>): Event {
  return createEvent({
    invocationId: 'test_inv',
    author: 'user',
    actions: {stateDelta},
  });
}

describe('FirestoreSessionService parity suite', () => {
  it('test_create_session', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(session.appName).toBe(APP_NAME);
    expect(session.userId).toBe(USER_ID);
    expect(session.id).toBeTruthy();
    expect(session.storageUpdateMarker).toBe('0');

    const doc = storedDoc(sessionPath(APP_NAME, USER_ID, session.id));
    expect(doc['id']).toBe(session.id);
    expect(doc['appName']).toBe(APP_NAME);
    expect(doc['userId']).toBe(USER_ID);
    expect(doc['revision']).toBe(0);
    expect(doc['createTime']).toEqual(FieldValue.serverTimestamp());
    expect(doc['updateTime']).toEqual(FieldValue.serverTimestamp());
    expect(storedState(sessionPath(APP_NAME, USER_ID, session.id))).toEqual({});
  });

  it('test_get_session_not_found', async () => {
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    // The reference asserts `None`; adk-js resolves `undefined`.
    expect(session).toBeUndefined();
    expect(client.calls).toContain(
      `get:${sessionPath(APP_NAME, USER_ID, SESSION_ID)}`,
    );
  });

  it('test_get_session_found', async () => {
    seedSession({state: {key: 'value'}, updateTime: 1234567890});
    client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, 'e1'), {
      event_data: {invocation_id: 'test_inv', author: 'user'},
      timestamp: 1,
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    if (!session) {
      expect.fail('the session was not found');
    }
    expect(session.id).toBe(SESSION_ID);
    expect(session.state).toEqual({key: 'value'});
    expect(session.events).toHaveLength(1);
    expect(session.events[0].invocationId).toBe('test_inv');
    expect(session.storageUpdateMarker).toBe('0');
  });

  it('test_delete_session', async () => {
    seedSession();
    const event = eventPath(APP_NAME, USER_ID, SESSION_ID, 'e1');
    client.put(event, {event_data: {}, timestamp: 1});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(client.batches).toHaveLength(1);
    expect(client.deleted).toEqual([event]);
    expect(client.batches[0].commits).toBe(1);
    expect(client.read(event)).toBeUndefined();
    expect(client.read(sessionPath(APP_NAME, USER_ID, SESSION_ID))).toBe(
      undefined,
    );
  });

  it('test_append_event', async () => {
    seedSession();
    const session = localSession();
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await service.appendEvent({session, event});

    const doc = storedDoc(sessionPath(APP_NAME, USER_ID, SESSION_ID));
    expect(doc['revision']).toBe(1);
    expect(doc['updateTime']).toEqual(FieldValue.serverTimestamp());
    expect(session.lastUpdateTime).toBe(event.timestamp);
    expect(
      client.read(eventPath(APP_NAME, USER_ID, SESSION_ID, event.id)),
    ).toBeDefined();
  });

  it('test_append_event_session_not_found', async () => {
    const session = localSession();
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await expect(service.appendEvent({session, event})).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it('test_append_event_rejects_stale_revision', async () => {
    seedSession({revision: 1});
    const session = localSession();
    session.storageUpdateMarker = '0';
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await expect(service.appendEvent({session, event})).rejects.toThrow(
      /modified in storage/,
    );
    await expect(service.appendEvent({session, event})).rejects.toThrow(
      StaleSessionError,
    );
    expect(client.writes).toEqual([]);
  });

  it('test_append_event_with_state_delta', async () => {
    seedSession();
    const session = localSession();
    // The reference uses `_app_`/`_user_` prefixes, which are not the scope
    // prefixes: every key lands in the session bucket, which is what makes the
    // persisted state equal to the whole in-memory state below.
    const event = eventWithDelta({
      _app_my_key: 'app_val',
      _user_my_key: 'user_val',
      session_key: 'session_val',
    });

    await service.appendEvent({session, event});

    expect(session.state['session_key']).toBe('session_val');
    const path = sessionPath(APP_NAME, USER_ID, SESSION_ID);
    expect(storedState(path)).toEqual(session.state);
    expect(storedDoc(path)['updateTime']).toEqual(FieldValue.serverTimestamp());
  });

  it('test_append_event_repeated_non_serializable_state_delta', async () => {
    seedSession();
    const session = localSession();

    // The second delta does not mention "callback", so the only copy of it
    // left for the second write is the raw one the base class merged into the
    // session.
    await service.appendEvent({
      session,
      event: eventWithDelta({callback: () => 1, ok: 2}),
    });
    await service.appendEvent({
      session,
      event: eventWithDelta({turn: 3}),
    });

    const path = sessionPath(APP_NAME, USER_ID, SESSION_ID);
    expect(storedDoc(path)['revision']).toBe(2);
    const persisted = storedState(path);
    expect(persisted['ok']).toBe(2);
    expect(persisted['turn']).toBe(3);
    expect(typeof persisted['callback']).toBe('string');
  });

  it('test_append_event_keeps_app_and_user_state_native', async () => {
    seedSession();
    const session = localSession();
    const when = new Date('2024-06-15T10:30:00.000Z');

    await service.appendEvent({
      session,
      event: eventWithDelta({
        'app:started': when,
        'user:seen': when,
        session_key: when,
      }),
    });

    expect(storedDoc(appStatePath(APP_NAME))['started']).toBe(when);
    expect(storedDoc(userStatePath(APP_NAME, USER_ID))['seen']).toBe(when);
    // The session bucket is JSON-encoded, so it is still coerced.
    const persisted = storedState(sessionPath(APP_NAME, USER_ID, SESSION_ID));
    expect(typeof persisted['session_key']).toBe('string');
  });

  it('test_create_session_keeps_app_and_user_state_native', async () => {
    const when = new Date('2024-06-15T10:30:00.000Z');

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:started': when, 'user:seen': when, session_key: when},
    });

    expect(storedDoc(appStatePath(APP_NAME))['started']).toBe(when);
    expect(storedDoc(userStatePath(APP_NAME, USER_ID))['seen']).toBe(when);
    const persisted = storedState(sessionPath(APP_NAME, USER_ID, session.id));
    expect(typeof persisted['session_key']).toBe('string');
  });

  it('test_append_event_with_temp_state', async () => {
    seedSession();
    const session = localSession();
    const event = eventWithDelta({
      'temp:k1': 'v1',
      session_key: 'session_val',
    });

    await service.appendEvent({session, event});

    // Divergence: adk-python keeps `temp:` keys readable in the in-memory
    // state for the rest of the invocation. `BaseSessionService` in adk-js
    // drops them instead, and this asserts what adk-js actually does. The
    // persistence half below matches the reference exactly.
    expect(session.state).not.toHaveProperty('temp:k1');
    expect(session.state['session_key']).toBe('session_val');

    const eventData = storedDoc(
      eventPath(APP_NAME, USER_ID, SESSION_ID, event.id),
    )['event_data'];
    expect(eventData).toMatchObject({
      actions: {state_delta: {session_key: 'session_val'}},
    });
    expect(eventData).not.toMatchObject({
      actions: {state_delta: {'temp:k1': 'v1'}},
    });

    const persisted = storedState(sessionPath(APP_NAME, USER_ID, SESSION_ID));
    expect(persisted).not.toHaveProperty('temp:k1');
    expect(persisted).toHaveProperty('session_key');
  });

  it('test_list_sessions_with_user_id', async () => {
    client.put(sessionPath(APP_NAME, USER_ID, 'session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: USER_ID,
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });
    client.put(appStatePath(APP_NAME), {app_key: 'app_val'});
    client.put(userStatePath(APP_NAME, USER_ID), {user_key: 'user_val'});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions).toHaveLength(1);
    const session = response.sessions[0];
    expect(session.id).toBe('session1');
    expect(session.state['session_key']).toBe('session_val');
    expect(session.state['app:app_key']).toBe('app_val');
    expect(session.state['user:user_key']).toBe('user_val');
    expect(session.lastUpdateTime).toBe(1234567890);
  });

  it('test_list_sessions_preserves_datetime_update_time', async () => {
    const updateTime = new Date('2024-06-15T10:30:00.000Z');
    client.put(sessionPath(APP_NAME, USER_ID, 'session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: USER_ID,
      state: {},
      updateTime,
    });

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    // The reference asserts epoch seconds; adk-js is uniform on milliseconds.
    expect(response.sessions[0].lastUpdateTime).toBe(updateTime.getTime());
  });

  it('test_list_sessions_without_user_id', async () => {
    client.put(sessionPath(APP_NAME, 'user1', 'session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });
    client.put(appStatePath(APP_NAME), {app_key: 'app_val'});
    client.put(userStatePath(APP_NAME, 'user1'), {user_key: 'user_val'});

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    const session = response.sessions[0];
    expect(session.id).toBe('session1');
    expect(session.state['app:app_key']).toBe('app_val');
    expect(session.state['user:user_key']).toBe('user_val');
    expect(session.lastUpdateTime).toBe(1234567890);
    expect(client.calls).toContain('collectionGroup:sessions');
    expect(client.calls).toContain('getAll:1');
  });

  it('test_list_sessions_filters_other_apps', async () => {
    client.put(sessionPath(APP_NAME, 'user1', 'session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
    });
    client.put(sessionPath('other_app', 'user2', 'session2'), {
      id: 'session2',
      appName: 'other_app',
      userId: 'user2',
      state: {},
    });

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe('session1');
    expect(response.sessions[0].appName).toBe(APP_NAME);
    expect(client.calls).toContain('collectionGroup:sessions');
  });

  it('test_create_session_already_exists', async () => {
    client.put(sessionPath(APP_NAME, USER_ID, 'existing_id'), {
      id: 'existing_id',
      appName: APP_NAME,
      userId: USER_ID,
      state: '{}',
    });

    await expect(
      service.createSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'existing_id',
      }),
    ).rejects.toThrow(AlreadyExistsError);
  });

  it('test_get_session_with_config', async () => {
    seedSession();
    for (const [id, timestamp] of [
      ['e1', 100],
      ['e2', 200],
      ['e3', 300],
    ] as const) {
      client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, id), {
        event_data: {invocation_id: id, author: 'user'},
        timestamp,
      });
    }

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp: 200, numRecentEvents: 5},
    });

    expect(session?.events.map((event) => event.invocationId)).toEqual([
      'e2',
      'e3',
    ]);
    expect(client.calls).toContain(
      `limitToLast:${sessionPath(APP_NAME, USER_ID, SESSION_ID)}/events`,
    );
  });

  it('test_get_session_with_zero_recent_events', async () => {
    seedSession();
    client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, 'e1'), {
      event_data: {invocation_id: 'inv', author: 'user'},
      timestamp: 1,
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {numRecentEvents: 0},
    });

    expect(session?.events).toEqual([]);
    const events = `${sessionPath(APP_NAME, USER_ID, SESSION_ID)}/events`;
    expect(client.calls).not.toContain(`query:${events}`);
    expect(client.calls).not.toContain(`limitToLast:${events}`);
  });

  it('test_get_session_after_timestamp_cursor_is_utc_aware', async () => {
    // The reference pins the process timezone, because a naive Python
    // datetime cursor is read as UTC on the wire. JavaScript has no naive
    // date, so the live risk here is the unit: the cursor is epoch
    // milliseconds, and it must land on exactly the instant requested.
    seedSession();
    const afterTimestamp = 1234567890000;
    for (const [id, timestamp] of [
      ['before', afterTimestamp - 1],
      ['exact', afterTimestamp],
    ] as const) {
      client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, id), {
        event_data: {invocation_id: id, author: 'user'},
        timestamp: new Date(timestamp),
      });
    }

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp},
    });

    expect(session?.events.map((event) => event.invocationId)).toEqual([
      'exact',
    ]);
  });

  it('test_delete_session_batching', async () => {
    seedSession();
    for (let index = 0; index < 501; index++) {
      client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, `e${index}`), {
        event_data: {},
        timestamp: index,
      });
    }

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    // The reference asserts two commits and 501 deletes on one mock batch;
    // the double hands out a fresh batch after each commit, so the same
    // counts appear as two batches that committed once each.
    expect(client.batches).toHaveLength(2);
    expect(client.batches.map((batch) => batch.commits)).toEqual([1, 1]);
    expect(client.deleted).toHaveLength(501);
  });

  it('test_append_event_partial', async () => {
    const session = localSession();
    const event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      partial: true,
    });

    const result = await service.appendEvent({session, event});

    expect(result).toBe(event);
    expect(client.batches).toEqual([]);
    expect(client.transactions).toEqual([]);
  });

  it('test_get_session_empty_data', async () => {
    client.put(sessionPath(APP_NAME, USER_ID, SESSION_ID), {});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeUndefined();
  });

  it('test_list_sessions_missing_states', async () => {
    client.put(sessionPath(APP_NAME, USER_ID, 'session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: USER_ID,
      state: {session_key: 'session_val'},
    });

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions).toHaveLength(1);
    const session = response.sessions[0];
    expect(session.id).toBe('session1');
    expect(session.state).toEqual({session_key: 'session_val'});
  });
});
