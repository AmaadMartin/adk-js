/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour `FirestoreSessionService` has that adk-python's reference does
 * not: list pagination, `GetSessionConfig` validation, `getUserState`, and the
 * millisecond timestamps adk-js carries. The ported reference tests live in
 * `firestore_session_service_test.ts`.
 */

import {Firestore, Timestamp} from '@google-cloud/firestore';
import {
  createEvent,
  createSession,
  FirestoreSessionService,
  InputValidationError,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeFirestore} from './fake_firestore.js';

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

const sessionPath = (sessionId: string, userId = USER_ID) =>
  `adk-session/${APP_NAME}/users/${userId}/sessions/${sessionId}`;
const userStatePath = (userId = USER_ID) =>
  `user_states/${APP_NAME}/users/${userId}`;

function seedSession(
  sessionId: string,
  fields: Record<string, unknown> = {},
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

describe('FirestoreSessionService (adk-js behaviour)', () => {
  let service: FirestoreSessionService;

  beforeEach(() => {
    fakeFirestore.reset();
    service = new FirestoreSessionService();
  });

  afterEach(() => {
    delete process.env.ADK_FIRESTORE_ROOT_COLLECTION;
  });

  describe('configuration', () => {
    it('defaults the root collection to adk-session', () => {
      expect(service.rootCollection).toBe('adk-session');
    });

    it('reads the root collection from ADK_FIRESTORE_ROOT_COLLECTION', async () => {
      process.env.ADK_FIRESTORE_ROOT_COLLECTION = 'other-root';
      const configured = new FirestoreSessionService();

      expect(configured.rootCollection).toBe('other-root');
      await configured.createSession({appName: APP_NAME, userId: USER_ID});
      expect(fakeFirestore.collectionIds).toContain('other-root');
    });

    it('prefers an explicit root collection over the environment', () => {
      process.env.ADK_FIRESTORE_ROOT_COLLECTION = 'other-root';

      expect(
        new FirestoreSessionService({rootCollection: 'explicit'})
          .rootCollection,
      ).toBe('explicit');
    });

    it('uses an injected client instead of creating one', async () => {
      const client = new Firestore();
      fakeFirestore.reset();
      const configured = new FirestoreSessionService({client});

      await configured.listSessions({appName: APP_NAME});

      expect(fakeFirestore.clientCount).toBe(0);
    });

    it('creates the client once and reuses it', async () => {
      await service.listSessions({appName: APP_NAME});
      await service.listSessions({appName: APP_NAME});

      expect(fakeFirestore.clientCount).toBe(1);
    });
  });

  describe('getSession', () => {
    it('rejects a negative numRecentEvents', async () => {
      await expect(
        service.getSession({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: 's1',
          config: {numRecentEvents: -1},
        }),
      ).rejects.toThrow(InputValidationError);
      expect(fakeFirestore.queries).toHaveLength(0);
    });

    it('reads lastUpdateTime from a Timestamp in milliseconds', async () => {
      seedSession('s1', {updateTime: Timestamp.fromMillis(1717413000000)});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.lastUpdateTime).toBe(1717413000000);
    });

    it('reads lastUpdateTime from a Date', async () => {
      const when = new Date('2024-06-15T10:30:00.000Z');
      seedSession('s1', {updateTime: when});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.lastUpdateTime).toBe(when.getTime());
    });

    it('scales a raw number, which adk-python writes as epoch seconds', async () => {
      seedSession('s1', {updateTime: 1717413000});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.lastUpdateTime).toBe(1717413000000);
    });

    it('reports no update time when the field is unreadable', async () => {
      seedSession('s1', {updateTime: 'not-a-time'});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.lastUpdateTime).toBe(0);
    });

    it('reports no update time for a non-finite number', async () => {
      seedSession('s1', {updateTime: Number.NaN});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.lastUpdateTime).toBe(0);
    });

    it('reports revision zero for a document written before revisions', async () => {
      fakeFirestore.setDocument(sessionPath('s1'), {
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
        state: '{}',
      });

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.storageUpdateMarker).toBe('0');
    });

    it('reads a state field stored as a JSON string', async () => {
      seedSession('s1', {state: JSON.stringify({turn: 2})});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.state).toEqual({turn: 2});
    });

    it('falls back to an empty state when the field holds neither', async () => {
      seedSession('s1', {state: 7});

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.state).toEqual({});
    });

    it('skips an event document with no event_data', async () => {
      seedSession('s1');
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/e1`, {
        timestamp: 1,
      });
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/e2`, {
        event_data: {invocation_id: 'inv', author: 'user'},
        timestamp: 2,
      });

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(session?.events).toHaveLength(1);
      expect(session?.events[0].invocationId).toBe('inv');
    });

    it('filters the events by afterTimestamp', async () => {
      seedSession('s1');
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/old`, {
        event_data: {invocation_id: 'old', author: 'user'},
        timestamp: Timestamp.fromMillis(1000),
      });
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/new`, {
        event_data: {invocation_id: 'new', author: 'user'},
        timestamp: Timestamp.fromMillis(3000),
      });

      const session = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
        config: {afterTimestamp: 2000},
      });

      expect(session?.events.map((event) => event.invocationId)).toEqual([
        'new',
      ]);
    });
  });

  describe('listSessions', () => {
    beforeEach(() => {
      // Three sessions, deliberately seeded out of update-time order.
      seedSession('s2', {updateTime: 2}, 'user_b');
      seedSession('s1', {updateTime: 1}, 'user_a');
      seedSession('s3', {updateTime: 3}, 'user_c');
    });

    it('returns every session as one page when no limit is given', async () => {
      const response = await service.listSessions({appName: APP_NAME});

      expect(response.sessions.map((session) => session.id)).toEqual([
        's1',
        's2',
        's3',
      ]);
      expect(response).toMatchObject({
        page: 1,
        limit: 3,
        totalItems: 3,
        totalPages: 1,
      });
    });

    it('reports zero pages when nothing matches', async () => {
      const response = await service.listSessions({appName: 'unknown_app'});

      expect(response).toEqual({
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 0,
        totalPages: 0,
      });
      expect(fakeFirestore.getAllPaths).toEqual([]);
    });

    it('flips only the update-time key with order desc', async () => {
      const response = await service.listSessions({
        appName: APP_NAME,
        order: 'desc',
      });

      expect(response.sessions.map((session) => session.id)).toEqual([
        's3',
        's2',
        's1',
      ]);
    });

    it('honours limit and offset', async () => {
      const response = await service.listSessions({
        appName: APP_NAME,
        limit: 2,
        offset: 1,
      });

      expect(response.sessions.map((session) => session.id)).toEqual([
        's2',
        's3',
      ]);
      expect(response).toMatchObject({
        page: 1,
        limit: 2,
        totalItems: 3,
        totalPages: 2,
      });
    });

    it('applies offset alone', async () => {
      const response = await service.listSessions({
        appName: APP_NAME,
        offset: 2,
      });

      expect(response.sessions.map((session) => session.id)).toEqual(['s3']);
    });

    it('lets page take precedence over offset', async () => {
      const response = await service.listSessions({
        appName: APP_NAME,
        limit: 2,
        offset: 99,
        page: 2,
      });

      expect(response.sessions.map((session) => session.id)).toEqual(['s3']);
      expect(response.page).toBe(2);
    });

    it('reports page one and zero pages for a limit of zero', async () => {
      const response = await service.listSessions({
        appName: APP_NAME,
        limit: 0,
      });

      expect(response).toEqual({
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 3,
        totalPages: 0,
      });
    });

    it('reads each distinct user state once, in sorted order', async () => {
      fakeFirestore.setDocument(userStatePath('user_a'), {tier: 'gold'});

      const response = await service.listSessions({appName: APP_NAME});

      expect(fakeFirestore.getAllPaths).toEqual([
        [
          userStatePath('user_a'),
          userStatePath('user_b'),
          userStatePath('user_c'),
        ],
      ]);
      expect(response.sessions[0].state['user:tier']).toBe('gold');
      expect(response.sessions[1].state).not.toHaveProperty('user:tier');
    });

    it('breaks an update-time tie on the user id, then the session id', async () => {
      fakeFirestore.reset();
      seedSession('sb', {updateTime: 5}, 'user_b');
      seedSession('sa', {updateTime: 5}, 'user_a');
      seedSession('sz', {updateTime: 5}, 'user_a');

      const ascending = await service.listSessions({appName: APP_NAME});
      const descending = await service.listSessions({
        appName: APP_NAME,
        order: 'desc',
      });

      expect(ascending.sessions.map((session) => session.id)).toEqual([
        'sa',
        'sz',
        'sb',
      ]);
      // `order` flips only the update-time key, so the tie-breakers hold.
      expect(descending.sessions.map((session) => session.id)).toEqual([
        'sa',
        'sz',
        'sb',
      ]);
    });

    it('ignores a session document with no user id', async () => {
      fakeFirestore.setDocument(
        `adk-session/${APP_NAME}/users/ghost/sessions/s4`,
        {id: 's4', appName: APP_NAME, state: '{}'},
      );

      const response = await service.listSessions({appName: APP_NAME});

      expect(fakeFirestore.getAllPaths[0]).toEqual([
        userStatePath('user_a'),
        userStatePath('user_b'),
        userStatePath('user_c'),
      ]);
      expect(response.totalItems).toBe(4);
    });
  });

  describe('getUserState', () => {
    it('returns the stored document without the user: prefix', async () => {
      fakeFirestore.setDocument(userStatePath(), {locale: 'en-US', tier: 1});

      const state = await service.getUserState({
        appName: APP_NAME,
        userId: USER_ID,
      });

      expect(state).toEqual({locale: 'en-US', tier: 1});
    });

    it('returns an empty state when nothing is stored', async () => {
      const state = await service.getUserState({
        appName: APP_NAME,
        userId: USER_ID,
      });

      expect(state).toEqual({});
    });
  });

  describe('appendEvent', () => {
    it('refuses to write to a session being deleted', async () => {
      seedSession('s1', {status: 'DELETING'});
      const session = createSession({
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
      });

      await expect(
        service.appendEvent({session, event: createEvent({author: 'user'})}),
      ).rejects.toThrow('Session s1 is currently being deleted.');
    });

    it('writes no undefined field, which Firestore rejects', async () => {
      seedSession('s1');
      const session = createSession({
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
      });
      // `branch` is one of several optional fields an event leaves unset.
      const event = createEvent({author: 'user'});
      expect(event).toHaveProperty('branch');
      expect(event.branch).toBeUndefined();

      await service.appendEvent({session, event});

      const persisted = fakeFirestore.getDocument(
        `${sessionPath('s1')}/events/${event.id}`,
      );
      expect(persisted?.['event_data']).not.toHaveProperty('branch');
    });

    it('treats a document written before revisions as revision zero', async () => {
      fakeFirestore.setDocument(sessionPath('s1'), {
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
        state: '{}',
      });
      const session = createSession({
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
      });

      await service.appendEvent({
        session,
        event: createEvent({author: 'user'}),
      });

      expect(session.storageUpdateMarker).toBe('1');
    });

    it('appends an event read back from storage that carries no actions', async () => {
      seedSession('s1');
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/e1`, {
        event_data: {invocation_id: 'inv', author: 'user'},
        timestamp: 1,
      });
      const stored = await service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });
      if (!stored) {
        expect.fail('the seeded session should be readable');
      }
      const target = createSession({
        id: 's2',
        appName: APP_NAME,
        userId: USER_ID,
      });
      seedSession('s2');

      await service.appendEvent({session: target, event: stored.events[0]});

      const persisted = fakeFirestore.getDocument(
        `${sessionPath('s2')}/events/${stored.events[0].id}`,
      );
      expect(persisted?.['event_data']).toMatchObject({
        invocation_id: 'inv',
        author: 'user',
      });
    });

    it('merges into the app and user documents already stored', async () => {
      seedSession('s1');
      fakeFirestore.setDocument(`app_states/${APP_NAME}`, {kept: 'app'});
      fakeFirestore.setDocument(userStatePath(), {kept: 'user'});
      const session = createSession({
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
      });

      await service.appendEvent({
        session,
        event: createEvent({
          author: 'user',
          state: {'app:added': 1, 'user:added': 2},
        }),
      });

      expect(fakeFirestore.getDocument(`app_states/${APP_NAME}`)).toEqual({
        kept: 'app',
        added: 1,
      });
      expect(fakeFirestore.getDocument(userStatePath())).toEqual({
        kept: 'user',
        added: 2,
      });
    });

    it('serializes concurrent appends to one session', async () => {
      seedSession('s1');
      const first = createSession({
        id: 's1',
        appName: APP_NAME,
        userId: USER_ID,
        storageUpdateMarker: '0',
      });

      await service.appendEvent({
        session: first,
        event: createEvent({author: 'user', state: {turn: 1}}),
      });
      expect(first.storageUpdateMarker).toBe('1');

      await service.appendEvent({
        session: first,
        event: createEvent({author: 'user', state: {turn: 2}}),
      });
      expect(first.storageUpdateMarker).toBe('2');
      expect(
        JSON.parse(
          String(fakeFirestore.getDocument(sessionPath('s1'))?.['state']),
        ),
      ).toEqual({turn: 2});
    });
  });

  describe('deleteSession', () => {
    it('marks the session as deleting before removing its events', async () => {
      seedSession('s1');

      await service.deleteSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(fakeFirestore.writesTo(sessionPath('s1'))).toEqual([
        {
          kind: 'update',
          path: sessionPath('s1'),
          data: {status: 'DELETING'},
          merge: false,
        },
      ]);
      expect(fakeFirestore.getDocument(sessionPath('s1'))).toBeUndefined();
    });

    it('deletes a session that has no events without committing a batch', async () => {
      seedSession('s1');

      await service.deleteSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(fakeFirestore.batchCommitCount).toBe(0);
      expect(fakeFirestore.deletedPaths).toEqual([sessionPath('s1')]);
    });

    it('deletes the session even when the marker write fails', async () => {
      seedSession('s1');
      fakeFirestore.setDocument(`${sessionPath('s1')}/events/e1`, {
        timestamp: 1,
      });
      fakeFirestore.transactionFailure = new Error('transaction unavailable');

      await service.deleteSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 's1',
      });

      expect(fakeFirestore.writes).toEqual([]);
      expect(fakeFirestore.batchDeletedPaths).toEqual([
        `${sessionPath('s1')}/events/e1`,
      ]);
      expect(fakeFirestore.deletedPaths).toEqual([sessionPath('s1')]);
    });

    it('leaves a missing session alone', async () => {
      await service.deleteSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'absent',
      });

      expect(fakeFirestore.writes).toEqual([]);
      expect(fakeFirestore.deletedPaths).toEqual([sessionPath('absent')]);
    });
  });
});
