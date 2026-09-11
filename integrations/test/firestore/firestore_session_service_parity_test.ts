/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * tests/unittests/integrations/firestore/test_firestore_session_service.py
 * (google/adk-python, main).
 *
 * Each `it(...)` keeps its Python test name verbatim, so a reviewer can grep
 * the two suites against each other. All 24 reference tests are ported.
 */

import {Firestore} from '@google-cloud/firestore';
import {
  AlreadyExistsError,
  createEvent,
  createEventActions,
  createSession,
  SessionNotFoundError,
  StaleSessionError,
} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FakeFirestore,
  fakeFirestores,
  FakeTimestamp,
  RecordedWrite,
  SERVER_TIMESTAMP,
} from './firestore_session_test_doubles.js';

vi.mock('@google-cloud/firestore', async () => {
  const fake = await import('./firestore_session_test_doubles.js');
  return {Firestore: fake.FakeFirestore, FieldValue: fake.FakeFieldValue};
});

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

const SESSION_PATH = `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${SESSION_ID}`;
const EVENTS_PATH = `${SESSION_PATH}/events`;
const APP_STATE_PATH = `app_states/${APP_NAME}`;
const USER_STATE_PATH = `user_states/${APP_NAME}/users/${USER_ID}`;

let client: Firestore;
let fake: FakeFirestore;
let service: FirestoreSessionService;

beforeEach(() => {
  fakeFirestores.length = 0;
  client = new Firestore();
  fake = fakeFirestores[0];
  service = new FirestoreSessionService({client});
});

/** The single write of `kind` recorded against `path`. */
function writeTo(kind: RecordedWrite['kind'], path: string): RecordedWrite {
  const found = fake.writes.filter((w) => w.kind === kind && w.path === path);
  if (found.length !== 1) {
    expect.fail(
      `expected exactly one ${kind} on ${path}, saw ${found.length} ` +
        `(writes: ${fake.writes.map((w) => `${w.kind} ${w.path}`).join(', ')})`,
    );
  }
  return found[0];
}

/** The session state as it was persisted, decoded from its JSON field. */
function persistedState(write: RecordedWrite): Record<string, unknown> {
  return JSON.parse(String(write.data['state'])) as Record<string, unknown>;
}

describe('FirestoreSessionService (ported from adk-python)', () => {
  it('test_create_session', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(session.appName).toBe(APP_NAME);
    expect(session.userId).toBe(USER_ID);
    expect(session.id).toBeTruthy();
    expect(session.storageUpdateMarker).toBe('0');

    const write = writeTo(
      'set',
      `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
    expect(write.data['id']).toBe(session.id);
    expect(write.data['appName']).toBe(APP_NAME);
    expect(write.data['userId']).toBe(USER_ID);
    expect(JSON.parse(String(write.data['state']))).toEqual({});
    expect(write.data['createTime']).toBe(SERVER_TIMESTAMP);
    expect(write.data['updateTime']).toBe(SERVER_TIMESTAMP);
    expect(write.data['revision']).toBe(0);
  });

  it('test_get_session_not_found', async () => {
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeUndefined();
  });

  it('test_get_session_found', async () => {
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: {key: 'value'},
      updateTime: 1234567890,
    });
    fake.seed(`${EVENTS_PATH}/e1`, {
      event_data: {invocation_id: 'test_inv', author: 'user'},
      timestamp: new FakeTimestamp(1),
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeDefined();
    expect(session?.id).toBe(SESSION_ID);
    expect(session?.state).toEqual({key: 'value'});
    expect(session?.events).toHaveLength(1);
    expect(session?.events[0].invocationId).toBe('test_inv');
    expect(session?.storageUpdateMarker).toBe('0');
  });

  it('test_delete_session', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    fake.seed(`${EVENTS_PATH}/e1`, {event_data: {author: 'user'}});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(
      fake.queryCalls.filter(
        (call) => call.method === 'stream' && call.source === EVENTS_PATH,
      ),
    ).toHaveLength(1);
    expect(fake.batchDeletes).toEqual([`${EVENTS_PATH}/e1`]);
    expect(fake.batchCommits).toBe(1);
    expect(fake.deletedPaths).toEqual([SESSION_PATH]);
    expect(fake.documents.has(SESSION_PATH)).toBe(false);
  });

  it('test_append_event', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await service.appendEvent({session, event});

    expect(fake.writes.filter((w) => w.kind === 'set')).not.toHaveLength(0);
    const update = writeTo('update', SESSION_PATH);
    expect(update.data['revision']).toBe(1);
    expect(update.data['updateTime']).toBe(SERVER_TIMESTAMP);
    expect(session.lastUpdateTime).toBe(event.timestamp);
  });

  it('test_append_event_session_not_found', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await expect(service.appendEvent({session, event})).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it('test_append_event_rejects_stale_revision', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 1});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      storageUpdateMarker: '0',
    });
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await expect(service.appendEvent({session, event})).rejects.toThrow(
      /modified in storage/,
    );
    await expect(service.appendEvent({session, event})).rejects.toThrow(
      StaleSessionError,
    );

    expect(fake.writes).toEqual([]);
  });

  it('test_append_event_with_state_delta', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      actions: createEventActions({
        stateDelta: {
          _app_my_key: 'app_val',
          _user_my_key: 'user_val',
          session_key: 'session_val',
        },
      }),
    });

    await service.appendEvent({session, event});

    expect(session.state['session_key']).toBe('session_val');
    const update = writeTo('update', SESSION_PATH);
    expect(persistedState(update)).toEqual(session.state);
    expect(update.data['updateTime']).toBe(SERVER_TIMESTAMP);

    // The stored event is snake_cased, as adk-python's `model_dump` writes it,
    // but the state delta's own keys are caller data and stay verbatim.
    const stored = writeTo('set', `${EVENTS_PATH}/${event.id}`).data[
      'event_data'
    ] as Record<string, Record<string, Record<string, unknown>>>;
    expect(stored['invocation_id']).toBe('test_inv');
    expect(stored['actions']['state_delta']['session_key']).toBe('session_val');
  });

  it('test_append_event_repeated_non_serializable_state_delta', async () => {
    // The raw delta the base class merges back must not break a later append.
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    // The second delta does not mention `callback`, so the only copy left for
    // the second write is the raw one the base class merged into the session.
    const deltas: Array<Record<string, unknown>> = [
      {callback: () => 1, ok: 2},
      {turn: 3},
    ];
    for (const stateDelta of deltas) {
      await service.appendEvent({
        session,
        event: createEvent({
          invocationId: 'test_inv',
          author: 'user',
          actions: createEventActions({stateDelta}),
        }),
      });
    }

    const updates = fake.writes.filter((w) => w.kind === 'update');
    expect(updates).toHaveLength(2);
    const state = persistedState(updates[1]);
    expect(state['ok']).toBe(2);
    expect(state['turn']).toBe(3);
    expect(typeof state['callback']).toBe('string');
  });

  it('test_append_event_keeps_app_and_user_state_native', async () => {
    // App and user state are written natively, so a Date stays a Date.
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const when = new Date('2024-06-15T10:30:00.000Z');

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'test_inv',
        author: 'user',
        actions: createEventActions({
          stateDelta: {
            'app:started': when,
            'user:seen': when,
            session_key: when,
          },
        }),
      }),
    });

    expect(writeTo('set', APP_STATE_PATH).data['started']).toBe(when);
    expect(writeTo('set', USER_STATE_PATH).data['seen']).toBe(when);
    // The session bucket is JSON-encoded, so it is still coerced.
    const state = persistedState(writeTo('update', SESSION_PATH));
    expect(state['session_key']).toBe(when.toISOString());
  });

  it('test_create_session_keeps_app_and_user_state_native', async () => {
    // createSession writes app and user state without coercing it.
    const when = new Date('2024-06-15T10:30:00.000Z');

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:started': when, 'user:seen': when, session_key: when},
    });

    expect(writeTo('set', APP_STATE_PATH).data['started']).toBe(when);
    expect(writeTo('set', USER_STATE_PATH).data['seen']).toBe(when);
    const write = writeTo(
      'set',
      `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
    expect(persistedState(write)['session_key']).toBe(when.toISOString());
  });

  it('test_append_event_with_temp_state', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      actions: createEventActions({
        stateDelta: {'temp:k1': 'v1', session_key: 'session_val'},
      }),
    });

    await service.appendEvent({session, event});

    expect(session.state['temp:k1']).toBe('v1');
    expect(session.state['session_key']).toBe('session_val');

    const eventWrite = writeTo('set', `${EVENTS_PATH}/${event.id}`);
    // The stored event is snake_cased, matching what adk-python writes.
    const stored = eventWrite.data['event_data'] as {
      actions: {state_delta: Record<string, unknown>};
    };
    expect(stored.actions.state_delta).not.toHaveProperty('temp:k1');
    expect(stored.actions.state_delta['session_key']).toBe('session_val');

    const update = writeTo('update', SESSION_PATH);
    expect(String(update.data['state'])).not.toContain('temp:k1');
    expect(persistedState(update)['session_key']).toBe('session_val');
  });

  it('test_list_sessions_with_user_id', async () => {
    fake.seed(APP_STATE_PATH, {app_key: 'app_val'});
    fake.seed(USER_STATE_PATH, {user_key: 'user_val'});
    fake.seed(`adk-session/${APP_NAME}/users/${USER_ID}/sessions/session1`, {
      id: 'session1',
      appName: APP_NAME,
      userId: USER_ID,
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });

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
    // listSessions converts a stored timestamp to lastUpdateTime.
    const updateTime = new Date('2024-06-15T10:30:00.000Z');
    fake.seed(`adk-session/${APP_NAME}/users/${USER_ID}/sessions/session1`, {
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

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].lastUpdateTime).toBe(updateTime.getTime());
  });

  it('test_list_sessions_without_user_id', async () => {
    fake.seed(APP_STATE_PATH, {app_key: 'app_val'});
    fake.seed(`user_states/${APP_NAME}/users/user1`, {user_key: 'user_val'});
    fake.seed(`adk-session/${APP_NAME}/users/user1/sessions/session1`, {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    const session = response.sessions[0];
    expect(session.id).toBe('session1');
    expect(session.state['app:app_key']).toBe('app_val');
    expect(session.state['user:user_key']).toBe('user_val');
    expect(session.lastUpdateTime).toBe(1234567890);

    expect(
      fake.queryCalls.filter(
        (call) => call.method === 'where' && call.source === 'group:sessions',
      ),
    ).toEqual([
      {
        method: 'where',
        source: 'group:sessions',
        args: ['appName', '==', APP_NAME],
      },
    ]);
  });

  it('test_list_sessions_filters_other_apps', async () => {
    fake.seed(`adk-session/${APP_NAME}/users/user1/sessions/session1`, {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
    });
    fake.seed('adk-session/other_app/users/user2/sessions/session2', {
      id: 'session2',
      appName: 'other_app',
      userId: 'user2',
      state: {},
    });

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe('session1');
    expect(response.sessions[0].appName).toBe(APP_NAME);
  });

  it('test_create_session_already_exists', async () => {
    fake.seed(`adk-session/${APP_NAME}/users/${USER_ID}/sessions/existing_id`, {
      id: 'existing_id',
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
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp: 1234567890, numRecentEvents: 5},
    });

    const onEvents = fake.queryCalls.filter((c) => c.source === EVENTS_PATH);
    expect(onEvents.filter((c) => c.method === 'where')).toHaveLength(1);
    expect(onEvents.filter((c) => c.method === 'limitToLast')).toEqual([
      {method: 'limitToLast', source: EVENTS_PATH, args: [5]},
    ]);
  });

  it('test_get_session_with_zero_recent_events', async () => {
    // A count of zero asks for no history at all: callers use it to check that
    // a session exists without paying for its transcript.
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    fake.seed(`${EVENTS_PATH}/e1`, {
      event_data: {invocation_id: 'inv', author: 'user'},
      timestamp: new FakeTimestamp(1),
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {numRecentEvents: 0},
    });

    expect(session).toBeDefined();
    expect(session?.events).toEqual([]);
    expect(fake.queryCalls.filter((c) => c.source === EVENTS_PATH)).toEqual([]);
  });

  it('test_get_session_after_timestamp_cursor_is_utc_aware', async () => {
    // The Python rationale does not transfer: a JS `Date` is an absolute
    // instant with no naive form, so the host's UTC offset cannot skew it.
    // What still needs pinning is that the cursor is the instant the caller
    // asked for, in milliseconds.
    const afterTimestamp = 1234567890000;
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp},
    });

    const where = fake.queryCalls.filter(
      (c) => c.method === 'where' && c.source === EVENTS_PATH,
    );
    expect(where).toHaveLength(1);
    expect(where[0].args).toEqual([
      'timestamp',
      '>=',
      new Date(afterTimestamp),
    ]);
  });

  it('test_delete_session_batching', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID});
    for (let i = 0; i < 501; i++) {
      fake.seed(`${EVENTS_PATH}/e${i}`, {event_data: {author: 'user'}});
    }

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(fake.batchCommits).toBe(2);
    expect(fake.batchDeletes).toHaveLength(501);
  });

  it('test_append_event_partial', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      partial: true,
    });

    const result = await service.appendEvent({session, event});

    expect(result).toBe(event);
    expect(fake.writes).toEqual([]);
    expect(fake.batchCommits).toBe(0);
  });

  it('test_get_session_empty_data', async () => {
    fake.seed(SESSION_PATH, {});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeUndefined();
  });

  it('test_list_sessions_missing_states', async () => {
    fake.seed(`adk-session/${APP_NAME}/users/${USER_ID}/sessions/session1`, {
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
    expect(session.state['session_key']).toBe('session_val');
    expect(session.state).not.toHaveProperty('app:app_key');
    expect(session.state).not.toHaveProperty('user:user_key');
  });
});
