/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference test suite of `FirestoreSessionService`, ported from
 * `tests/unittests/integrations/firestore/test_firestore_session_service.py`
 * at `google/adk-python` `main`.
 *
 * Each `it()` keeps the Python test name verbatim, so a reviewer can grep the
 * reference for it. adk-js-only behaviour lives in
 * `firestore_session_service_adk_js_test.ts`.
 */

import {FieldValue, Timestamp} from '@google-cloud/firestore';
import {
  AlreadyExistsError,
  createEvent,
  createSession,
  Event,
  FirestoreSessionService,
  SessionNotFoundError,
  StaleSessionError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeFirestore, RecordedWrite} from './fake_firestore.js';

vi.mock('@google-cloud/firestore', async () => {
  const actual = await vi.importActual<
    typeof import('@google-cloud/firestore')
  >('@google-cloud/firestore');
  const {FakeFirestore} = await import('./fake_firestore.js');
  return {
    Firestore: FakeFirestore,
    FieldValue: actual.FieldValue,
    Timestamp: actual.Timestamp,
  };
});

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

const sessionPath = (sessionId = SESSION_ID, userId = USER_ID) =>
  `adk-session/${APP_NAME}/users/${userId}/sessions/${sessionId}`;
const appStatePath = `app_states/${APP_NAME}`;
const userStatePath = (userId = USER_ID) =>
  `user_states/${APP_NAME}/users/${userId}`;

/** Seeds a session document at revision `revision`. */
function seedSession(
  fields: Record<string, unknown> = {},
  sessionId = SESSION_ID,
  userId = USER_ID,
): void {
  fakeFirestore.setDocument(sessionPath(sessionId, userId), {
    id: sessionId,
    appName: APP_NAME,
    userId,
    state: '{}',
    revision: 0,
    ...fields,
  });
}

/** The single write recorded against a path. */
function onlyWriteTo(path: string): RecordedWrite {
  const writes = fakeFirestore.writesTo(path);
  expect(writes).toHaveLength(1);
  return writes[0];
}

describe('FirestoreSessionService (ported from adk-python)', () => {
  let service: FirestoreSessionService;

  beforeEach(() => {
    fakeFirestore.reset();
    service = new FirestoreSessionService();
  });

  it('test_create_session', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(session.appName).toBe(APP_NAME);
    expect(session.userId).toBe(USER_ID);
    expect(session.id).toBeTruthy();
    expect(session.storageUpdateMarker).toBe('0');

    expect(fakeFirestore.collectionIds).toContain('adk-session');
    expect(fakeFirestore.collectionIds).toContain('app_states');
    expect(fakeFirestore.collectionIds).toContain('user_states');

    const write = onlyWriteTo(sessionPath(session.id));
    expect(write.data['id']).toBe(session.id);
    expect(write.data['appName']).toBe(APP_NAME);
    expect(write.data['userId']).toBe(USER_ID);
    expect(JSON.parse(String(write.data['state']))).toEqual({});
    expect(
      (write.data['createTime'] as FieldValue).isEqual(
        FieldValue.serverTimestamp(),
      ),
    ).toBe(true);
    expect(
      (write.data['updateTime'] as FieldValue).isEqual(
        FieldValue.serverTimestamp(),
      ),
    ).toBe(true);
  });

  it('test_get_session_not_found', async () => {
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeUndefined();
    // The reference asserts the path segment by segment against its mock; the
    // fake stores whole paths, so the equivalent assertion is that nothing was
    // read outside the documented layout.
    expect(fakeFirestore.collectionIds).toContain('adk-session');
    expect(fakeFirestore.queries).toHaveLength(0);
  });

  it('test_get_session_found', async () => {
    seedSession({state: {key: 'value'}, updateTime: 1234567890});
    fakeFirestore.setDocument(`${sessionPath()}/events/e1`, {
      event_data: {invocation_id: 'test_inv', author: 'user'},
      timestamp: 1,
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
    seedSession();
    fakeFirestore.setDocument(`${sessionPath()}/events/e1`, {timestamp: 1});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(fakeFirestore.queriesEndingWith('/events')).toHaveLength(1);
    expect(fakeFirestore.batchCount).toBe(1);
    expect(fakeFirestore.batchDeletedPaths).toEqual([
      `${sessionPath()}/events/e1`,
    ]);
    expect(fakeFirestore.batchCommitCount).toBe(1);
    expect(fakeFirestore.deletedPaths).toEqual([sessionPath()]);
  });

  it('test_append_event', async () => {
    seedSession();
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({invocationId: 'test_inv', author: 'user'});

    await service.appendEvent({session, event});

    expect(fakeFirestore.writes.some((write) => write.kind === 'set')).toBe(
      true,
    );
    const update = onlyWriteTo(sessionPath());
    expect(update.kind).toBe('update');
    expect(update.data['revision']).toBe(1);
    expect(
      (update.data['updateTime'] as FieldValue).isEqual(
        FieldValue.serverTimestamp(),
      ),
    ).toBe(true);
    expect(session.lastUpdateTime).toBe(event.timestamp);
  });

  it('test_append_event_session_not_found', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await expect(
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'test_inv', author: 'user'}),
      }),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('test_append_event_rejects_stale_revision', async () => {
    seedSession({revision: 1});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      storageUpdateMarker: '0',
    });

    const rejected = service.appendEvent({
      session,
      event: createEvent({invocationId: 'test_inv', author: 'user'}),
    });
    await expect(rejected).rejects.toThrow(StaleSessionError);
    await expect(rejected).rejects.toThrow(/modified in storage/);

    expect(fakeFirestore.writes).toHaveLength(0);
  });

  it('test_append_event_with_state_delta', async () => {
    // The reference patches two private methods the current implementation no
    // longer calls and drives a MagicMock event; the ported assertion is the
    // surviving one, against a real Event.
    seedSession();
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'test_inv',
        author: 'user',
        state: {
          'app:my_key': 'app_val',
          'user:my_key': 'user_val',
          session_key: 'session_val',
        },
      }),
    });

    expect(session.state['session_key']).toBe('session_val');
    expect(onlyWriteTo(appStatePath).data).toEqual({my_key: 'app_val'});
    expect(onlyWriteTo(userStatePath()).data).toEqual({my_key: 'user_val'});

    const update = onlyWriteTo(sessionPath());
    expect(JSON.parse(String(update.data['state']))).toEqual({
      session_key: 'session_val',
    });
    expect(
      (update.data['updateTime'] as FieldValue).isEqual(
        FieldValue.serverTimestamp(),
      ),
    ).toBe(true);
  });

  it('test_append_event_repeated_non_serializable_state_delta', async () => {
    seedSession();
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    // The second delta does not mention "callback", so the only copy of it
    // left for the second write is the raw one the base class merged in.
    const deltas: Array<Record<string, unknown>> = [
      {callback: () => 1, ok: 2},
      {turn: 3},
    ];
    for (const state of deltas) {
      await service.appendEvent({
        session,
        event: createEvent({invocationId: 'test_inv', author: 'user', state}),
      });
    }

    const updates = fakeFirestore.writesTo(sessionPath());
    expect(updates).toHaveLength(2);
    const persisted = JSON.parse(String(updates[1].data['state']));
    expect(persisted['ok']).toBe(2);
    expect(persisted['turn']).toBe(3);
    expect(typeof persisted['callback']).toBe('string');
  });

  it('test_append_event_keeps_app_and_user_state_native', async () => {
    seedSession();
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
        state: {'app:started': when, 'user:seen': when, session_key: when},
      }),
    });

    expect(onlyWriteTo(appStatePath).data['started']).toBe(when);
    expect(onlyWriteTo(userStatePath()).data['seen']).toBe(when);
    // The session bucket is JSON-encoded, so it is still coerced.
    const persisted = JSON.parse(
      String(onlyWriteTo(sessionPath()).data['state']),
    );
    expect(typeof persisted['session_key']).toBe('string');
  });

  it('test_create_session_keeps_app_and_user_state_native', async () => {
    const when = new Date('2024-06-15T10:30:00.000Z');

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:started': when, 'user:seen': when, session_key: when},
    });

    expect(onlyWriteTo(appStatePath).data['started']).toBe(when);
    expect(onlyWriteTo(userStatePath()).data['seen']).toBe(when);
    const persisted = JSON.parse(
      String(onlyWriteTo(sessionPath(session.id)).data['state']),
    );
    expect(typeof persisted['session_key']).toBe('string');
  });

  it('test_append_event_with_temp_state', async () => {
    seedSession();
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      state: {'temp:k1': 'v1', session_key: 'session_val'},
    });

    await service.appendEvent({session, event});

    expect(session.state['temp:k1']).toBe('v1');
    expect(session.state['session_key']).toBe('session_val');

    const eventWrites = fakeFirestore.writes.filter(
      (write) => write.data['event_data'] !== undefined,
    );
    expect(eventWrites).toHaveLength(1);
    const eventData = eventWrites[0].data['event_data'];
    // The persisted event is snake_case, as adk-python writes it.
    expect(eventData).toMatchObject({
      actions: {state_delta: {session_key: 'session_val'}},
    });
    expect(JSON.stringify(eventData)).not.toContain('temp:k1');

    const persisted = String(onlyWriteTo(sessionPath()).data['state']);
    expect(persisted).not.toContain('temp:k1');
    expect(persisted).toContain('session_key');
  });

  it('test_list_sessions_with_user_id', async () => {
    fakeFirestore.setDocument(sessionPath('session1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: USER_ID,
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });
    fakeFirestore.setDocument(appStatePath, {app_key: 'app_val'});
    fakeFirestore.setDocument(userStatePath(), {user_key: 'user_val'});

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
    // adk-python stores epoch seconds; adk-js carries milliseconds.
    expect(session.lastUpdateTime).toBe(1234567890000);
    expect(fakeFirestore.collectionGroupIds).toHaveLength(0);
    expect(fakeFirestore.queries[0].wheres).toEqual([
      {field: 'appName', op: '==', value: APP_NAME},
    ]);
  });

  it('test_list_sessions_preserves_datetime_update_time', async () => {
    const updateTime = new Date('2024-06-15T10:30:00.000Z');
    fakeFirestore.setDocument(sessionPath('session1'), {
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
    fakeFirestore.setDocument(sessionPath('session1', 'user1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
      updateTime: 1234567890,
    });
    fakeFirestore.setDocument(appStatePath, {app_key: 'app_val'});
    fakeFirestore.setDocument(userStatePath('user1'), {user_key: 'user_val'});

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    const session = response.sessions[0];
    expect(session.id).toBe('session1');
    expect(session.state['app:app_key']).toBe('app_val');
    expect(session.state['user:user_key']).toBe('user_val');
    expect(session.lastUpdateTime).toBe(1234567890000);

    expect(fakeFirestore.collectionGroupIds).toEqual(['sessions']);
    expect(fakeFirestore.queries[0].wheres).toEqual([
      {field: 'appName', op: '==', value: APP_NAME},
    ]);
    expect(fakeFirestore.getAllPaths).toEqual([[userStatePath('user1')]]);
  });

  it('test_list_sessions_filters_other_apps', async () => {
    fakeFirestore.setDocument(sessionPath('session1', 'user1'), {
      id: 'session1',
      appName: APP_NAME,
      userId: 'user1',
      state: {session_key: 'session_val'},
    });
    fakeFirestore.setDocument(
      `adk-session/other_app/users/user1/sessions/session2`,
      {
        id: 'session2',
        appName: 'other_app',
        userId: 'user1',
        state: {},
      },
    );

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe('session1');
    expect(response.sessions[0].appName).toBe(APP_NAME);
    expect(fakeFirestore.collectionGroupIds).toEqual(['sessions']);
  });

  it('test_create_session_already_exists', async () => {
    seedSession({}, 'existing_id');

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

    await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp: 1234567890, numRecentEvents: 5},
    });

    const [query] = fakeFirestore.queriesEndingWith('/events');
    expect(query.wheres).toHaveLength(1);
    expect(query.limitToLast).toBe(5);
  });

  it('test_get_session_with_zero_recent_events', async () => {
    // A count of zero probes for existence, so the events query must be
    // skipped rather than issued and thrown away.
    seedSession();
    fakeFirestore.setDocument(`${sessionPath()}/events/e1`, {
      event_data: {invocation_id: 'inv', author: 'user'},
      timestamp: 1,
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {numRecentEvents: 0},
    });

    expect(session).toBeDefined();
    expect(session?.events).toEqual([]);
    expect(fakeFirestore.queriesEndingWith('/events')).toHaveLength(0);
  });

  it('test_get_session_after_timestamp_cursor_is_utc_aware', async () => {
    // The reference pins a Python-only hazard: a naive datetime cursor read as
    // UTC on the wire. TypeScript has no naive instant, so the ported
    // assertion is that the cursor is the Timestamp the milliseconds name.
    seedSession();
    const afterTimestamp = 1234567890000;

    await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp},
    });

    const [query] = fakeFirestore.queriesEndingWith('/events');
    expect(query.wheres).toHaveLength(1);
    const [{field, op, value}] = query.wheres;
    expect([field, op]).toEqual(['timestamp', '>=']);
    expect(
      (value as Timestamp).isEqual(Timestamp.fromMillis(afterTimestamp)),
    ).toBe(true);
  });

  it('test_delete_session_batching', async () => {
    seedSession();
    for (let index = 0; index < 501; index++) {
      fakeFirestore.setDocument(`${sessionPath()}/events/e${index}`, {
        timestamp: index,
      });
    }

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(fakeFirestore.batchCommitCount).toBe(2);
    expect(fakeFirestore.batchDeletedPaths).toHaveLength(501);
  });

  it('test_append_event_partial', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event: Event = createEvent({
      invocationId: 'test_inv',
      author: 'user',
      partial: true,
    });

    const result = await service.appendEvent({session, event});

    expect(result).toBe(event);
    expect(fakeFirestore.batchCount).toBe(0);
    expect(fakeFirestore.writes).toHaveLength(0);
  });

  it('test_get_session_empty_data', async () => {
    fakeFirestore.setDocument(sessionPath(), {});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session).toBeUndefined();
  });

  it('test_list_sessions_missing_states', async () => {
    fakeFirestore.setDocument(sessionPath('session1'), {
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
