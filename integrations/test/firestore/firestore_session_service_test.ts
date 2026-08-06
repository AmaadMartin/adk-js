/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Timestamp} from '@google-cloud/firestore';
import {
  createEvent,
  createEventActions,
  createSession,
  Event,
  Session,
} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  APP_STATE_COLLECTION,
  DEFAULT_ROOT_COLLECTION,
  EVENTS_COLLECTION,
  ROOT_COLLECTION_ENV_VAR,
  SESSIONS_COLLECTION,
  USER_STATE_COLLECTION,
  USERS_COLLECTION,
} from '../../src/firestore/firestore_session_service.js';

import {
  createFakeFirestore,
  FakeStore,
  StoredDocument,
} from './fake_firestore.js';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const APP_STATE_PATH = `${APP_STATE_COLLECTION}/${APP_NAME}`;
const USER_STATE_PATH = `${USER_STATE_COLLECTION}/${APP_NAME}/${USERS_COLLECTION}/${USER_ID}`;

/** Full path of a session document under the default root collection. */
function sessionPath(sessionId: string, userId = USER_ID): string {
  return `${DEFAULT_ROOT_COLLECTION}/${APP_NAME}/${USERS_COLLECTION}/${userId}/${SESSIONS_COLLECTION}/${sessionId}`;
}

/** Full path of an event document. */
function eventPath(sessionId: string, eventId: string): string {
  return `${sessionPath(sessionId)}/${EVENTS_COLLECTION}/${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Epoch milliseconds of a stored Timestamp field. */
function toMillis(value: unknown): number {
  if (!isRecord(value) || typeof value.toMillis !== 'function') {
    expect.fail(`expected a Timestamp, got ${String(value)}`);
  }
  return Number(value.toMillis());
}

/** Narrows a stored field to a record, failing the test when it is not one. */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    expect.fail(`expected ${what} to be an object, got ${String(value)}`);
  }
  return value;
}

let store: FakeStore;
let service: FirestoreSessionService;

const originalRootCollection = process.env[ROOT_COLLECTION_ENV_VAR];

beforeEach(() => {
  delete process.env[ROOT_COLLECTION_ENV_VAR];
  const fake = createFakeFirestore();
  store = fake.store;
  service = new FirestoreSessionService({client: fake.client});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRootCollection === undefined) {
    delete process.env[ROOT_COLLECTION_ENV_VAR];
  } else {
    process.env[ROOT_COLLECTION_ENV_VAR] = originalRootCollection;
  }
});

/** The raw session document, failing the test when it is missing. */
function storedSession(sessionId: string): StoredDocument {
  const data = store.documents.get(sessionPath(sessionId));
  if (!data) {
    expect.fail(`no session document at ${sessionPath(sessionId)}`);
  }
  return data;
}

/** The session-scoped state persisted on a session document. */
function storedState(sessionId: string): Record<string, unknown> {
  const raw = storedSession(sessionId).state;
  if (typeof raw !== 'string') {
    expect.fail(`expected a JSON string state, got ${String(raw)}`);
  }
  return asRecord(JSON.parse(raw), 'the parsed session state');
}

/** The serialized event stored on an event document. */
function storedEvent(sessionId: string, eventId: string): StoredDocument {
  const doc = store.documents.get(eventPath(sessionId, eventId));
  if (!doc) {
    expect.fail(`no event document at ${eventPath(sessionId, eventId)}`);
  }
  return asRecord(doc['event_data'], 'the stored event_data');
}

function newEvent(params: Partial<Event> = {}): Event {
  return createEvent({author: 'user', invocationId: 'inv-1', ...params});
}

function eventWithDelta(
  id: string,
  stateDelta: Record<string, unknown>,
): Event {
  return newEvent({id, actions: createEventActions({stateDelta})});
}

/** Writes a session document directly, bypassing the service. */
function seedSession(
  sessionId: string,
  fields: StoredDocument = {},
  userId = USER_ID,
): void {
  store.write(sessionPath(sessionId, userId), {
    id: sessionId,
    appName: APP_NAME,
    userId,
    state: JSON.stringify({}),
    createTime: Timestamp.fromMillis(0),
    updateTime: Timestamp.fromMillis(0),
    revision: 0,
    ...fields,
  });
}

describe('collection constants', () => {
  it('match the names adk-python uses', () => {
    expect(DEFAULT_ROOT_COLLECTION).toBe('adk-session');
    expect(SESSIONS_COLLECTION).toBe('sessions');
    expect(EVENTS_COLLECTION).toBe('events');
    expect(APP_STATE_COLLECTION).toBe('app_states');
    expect(USER_STATE_COLLECTION).toBe('user_states');
    expect(USERS_COLLECTION).toBe('users');
    expect(ROOT_COLLECTION_ENV_VAR).toBe('ADK_FIRESTORE_ROOT_COLLECTION');
  });
});

describe('FirestoreSessionService root collection', () => {
  it('defaults to adk-session', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect([...store.documents.keys()]).toContain(
      `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
  });

  it('builds a default client when none is supplied', () => {
    expect(() => new FirestoreSessionService()).not.toThrow();
  });

  it('reads ADK_FIRESTORE_ROOT_COLLECTION when no option is given', async () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'env-root';
    const fake = createFakeFirestore();
    const envService = new FirestoreSessionService({client: fake.client});

    const session = await envService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect([...fake.store.documents.keys()]).toContain(
      `env-root/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
  });

  it('prefers the rootCollection option over the environment variable', async () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'env-root';
    const fake = createFakeFirestore();
    const optionService = new FirestoreSessionService({
      client: fake.client,
      rootCollection: 'option-root',
    });

    const session = await optionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect([...fake.store.documents.keys()]).toContain(
      `option-root/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
  });

  it('falls back to the default when the environment variable is empty', async () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = '';
    const fake = createFakeFirestore();
    const envService = new FirestoreSessionService({client: fake.client});

    const session = await envService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect([...fake.store.documents.keys()]).toContain(
      `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
    );
  });
});

describe('FirestoreSessionService.createSession', () => {
  it('returns a session with a generated id and no events', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(session.appName).toBe(APP_NAME);
    expect(session.userId).toBe(USER_ID);
    expect(session.id).not.toBe('');
    expect(session.events).toEqual([]);
    expect(session.state).toEqual({});
  });

  it('writes the session document at the parity path with revision 0', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {turn: 1},
    });

    const document = storedSession(session.id);
    expect(document.id).toBe(session.id);
    expect(document.appName).toBe(APP_NAME);
    expect(document.userId).toBe(USER_ID);
    expect(document.revision).toBe(0);
    expect(document.state).toBe(JSON.stringify({turn: 1}));
    expect(toMillis(document.createTime)).toBe(toMillis(document.updateTime));
    expect(toMillis(document.updateTime)).toBe(session.lastUpdateTime);
  });

  it('honours an explicit session id', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'explicit-id',
    });

    expect(session.id).toBe('explicit-id');
    expect(store.documents.has(sessionPath('explicit-id'))).toBe(true);
  });

  it('splits prefixed initial state into the shared documents', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:theme': 'dark', 'user:locale': 'en', turn: 0},
    });

    expect(store.documents.get(APP_STATE_PATH)).toEqual({theme: 'dark'});
    expect(store.documents.get(USER_STATE_PATH)).toEqual({locale: 'en'});
    expect(storedState(session.id)).toEqual({turn: 0});
  });

  it('returns the shared state merged back under its prefixes', async () => {
    store.write(APP_STATE_PATH, {existing: 'app'});
    store.write(USER_STATE_PATH, {existing: 'user'});

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:theme': 'dark', turn: 0},
    });

    expect(session.state).toEqual({
      turn: 0,
      'app:existing': 'app',
      'app:theme': 'dark',
      'user:existing': 'user',
    });
  });

  it('rejects a duplicate session id and rolls the transaction back', async () => {
    seedSession('taken', {revision: 7});
    const before = storedSession('taken');

    await expect(
      service.createSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'taken',
        state: {'app:theme': 'dark'},
      }),
    ).rejects.toThrow('Session with id taken already exists.');

    expect(storedSession('taken')).toEqual(before);
    expect(store.documents.has(APP_STATE_PATH)).toBe(false);
  });

  it('never persists temporary state', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'temp:scratch': 'x', turn: 0},
    });

    expect(storedState(session.id)).toEqual({turn: 0});
    for (const document of store.documents.values()) {
      expect(JSON.stringify(document)).not.toContain('temp:');
    }
  });
});

describe('FirestoreSessionService.getSession', () => {
  it('returns undefined for an unknown session', async () => {
    await expect(
      service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'missing',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a session document with no fields', async () => {
    store.write(sessionPath('empty'), {});

    await expect(
      service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'empty',
      }),
    ).resolves.toBeUndefined();
  });

  it('round-trips appended events in timestamp order', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'second', timestamp: 2000}),
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'first', timestamp: 1000}),
    });

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });

    expect(loaded?.events.map((event) => event.id)).toEqual([
      'first',
      'second',
    ]);
    expect(loaded?.events[0].author).toBe('user');
  });

  it('merges shared state written for the same app and user', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {turn: 3},
    });
    store.write(APP_STATE_PATH, {theme: 'dark'});
    store.write(USER_STATE_PATH, {locale: 'en'});

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });

    expect(loaded?.state).toEqual({
      turn: 3,
      'app:theme': 'dark',
      'user:locale': 'en',
    });
  });

  it('returns only the most recent events for numRecentEvents', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'old', timestamp: 1000}),
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'new', timestamp: 2000}),
    });

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      config: {numRecentEvents: 1},
    });

    expect(loaded?.events.map((event) => event.id)).toEqual(['new']);
  });

  it('skips the events query entirely when numRecentEvents is 0', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({session, event: newEvent({id: 'e1'})});

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      config: {numRecentEvents: 0},
    });

    expect(loaded?.events).toEqual([]);
    expect(
      store.queryPaths.filter((path) => path.endsWith(`/${EVENTS_COLLECTION}`)),
    ).toEqual([]);
  });

  it('includes an event whose timestamp equals afterTimestamp', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'before', timestamp: 1000}),
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'boundary', timestamp: 2000}),
    });

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      config: {afterTimestamp: 2000},
    });

    expect(loaded?.events.map((event) => event.id)).toEqual(['boundary']);
  });

  it('reads a session document whose state is a plain map', async () => {
    seedSession('legacy', {state: {turn: 9}});

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'legacy',
    });

    expect(loaded?.state).toEqual({turn: 9});
  });

  it('reports lastUpdateTime 0 when the document has no updateTime', async () => {
    store.write(sessionPath('no-update-time'), {id: 'no-update-time'});

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'no-update-time',
    });

    expect(loaded?.lastUpdateTime).toBe(0);
    expect(loaded?.state).toEqual({});
  });
});

describe('FirestoreSessionService.listSessions', () => {
  it('returns only the sessions of the requested app and user', async () => {
    seedSession('mine');
    seedSession('theirs', {}, 'other-user');
    store.write(
      `${DEFAULT_ROOT_COLLECTION}/other-app/${USERS_COLLECTION}/${USER_ID}/${SESSIONS_COLLECTION}/elsewhere`,
      {id: 'elsewhere'},
    );

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions.map((session) => session.id)).toEqual(['mine']);
  });

  it('merges shared state and returns no events', async () => {
    seedSession('s1', {state: JSON.stringify({turn: 1})});
    store.write(APP_STATE_PATH, {theme: 'dark'});
    store.write(USER_STATE_PATH, {locale: 'en'});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions[0].state).toEqual({
      turn: 1,
      'app:theme': 'dark',
      'user:locale': 'en',
    });
    expect(response.sessions[0].events).toEqual([]);
  });

  it('tolerates absent shared-state documents', async () => {
    seedSession('s1', {state: JSON.stringify({turn: 1})});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions[0].state).toEqual({turn: 1});
  });

  it('preserves lastUpdateTime as epoch milliseconds', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({
      session,
      event: newEvent({id: 'e1', timestamp: 1_700_000_000_123}),
    });

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions[0].lastUpdateTime).toBe(1_700_000_000_123);
  });

  it('reports whole-collection pagination metadata when no limit is given', async () => {
    seedSession('a');
    seedSession('b');
    seedSession('c');

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response.sessions).toHaveLength(3);
    expect(response).toMatchObject({
      page: 1,
      limit: 3,
      totalItems: 3,
      totalPages: 1,
    });
  });

  it('paginates by limit and offset', async () => {
    seedSession('a', {updateTime: Timestamp.fromMillis(1)});
    seedSession('b', {updateTime: Timestamp.fromMillis(2)});
    seedSession('c', {updateTime: Timestamp.fromMillis(3)});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'asc',
      limit: 2,
      offset: 1,
    });

    expect(response.sessions.map((session) => session.id)).toEqual(['b', 'c']);
    expect(response).toMatchObject({
      page: 1,
      limit: 2,
      totalItems: 3,
      totalPages: 2,
    });
  });

  it('paginates by limit and page', async () => {
    seedSession('a', {updateTime: Timestamp.fromMillis(1)});
    seedSession('b', {updateTime: Timestamp.fromMillis(2)});
    seedSession('c', {updateTime: Timestamp.fromMillis(3)});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'asc',
      limit: 2,
      page: 2,
    });

    expect(response.sessions.map((session) => session.id)).toEqual(['c']);
    expect(response).toMatchObject({
      page: 2,
      limit: 2,
      totalItems: 3,
      totalPages: 2,
    });
  });

  it('applies an offset when no limit is given', async () => {
    seedSession('a', {updateTime: Timestamp.fromMillis(1)});
    seedSession('b', {updateTime: Timestamp.fromMillis(2)});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'asc',
      offset: 1,
    });

    expect(response.sessions.map((session) => session.id)).toEqual(['b']);
    expect(response).toMatchObject({page: 1, limit: 2, totalItems: 2});
  });

  it('starts at the first page for a limit with no offset or page', async () => {
    seedSession('a', {updateTime: Timestamp.fromMillis(1)});
    seedSession('b', {updateTime: Timestamp.fromMillis(2)});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'asc',
      limit: 1,
    });

    expect(response.sessions.map((session) => session.id)).toEqual(['a']);
    expect(response).toMatchObject({
      page: 1,
      limit: 1,
      totalItems: 2,
      totalPages: 2,
    });
  });

  it('returns nothing for a zero limit', async () => {
    seedSession('a');

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      limit: 0,
    });

    expect(response).toEqual({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 1,
      totalPages: 0,
    });
  });

  it('reports an empty page for a user with no sessions', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(response).toEqual({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('reports zero total pages for a limited query with no results', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      limit: 2,
      page: 3,
    });

    expect(response).toEqual({
      sessions: [],
      page: 3,
      limit: 2,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('sorts by lastUpdateTime, breaking ties on id', async () => {
    seedSession('b', {updateTime: Timestamp.fromMillis(1)});
    seedSession('a', {updateTime: Timestamp.fromMillis(1)});
    seedSession('c', {updateTime: Timestamp.fromMillis(2)});

    const ascending = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'asc',
    });
    expect(ascending.sessions.map((session) => session.id)).toEqual([
      'a',
      'b',
      'c',
    ]);

    const descending = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'desc',
    });
    expect(descending.sessions.map((session) => session.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('FirestoreSessionService.deleteSession', () => {
  it('deletes the session document and every event under it', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await service.appendEvent({session, event: newEvent({id: 'e1'})});
    await service.appendEvent({session, event: newEvent({id: 'e2'})});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });

    const remaining = [...store.documents.keys()].filter((path) =>
      path.startsWith(sessionPath(session.id)),
    );
    expect(remaining).toEqual([]);
  });

  it('marks the session as deleting before removing it', async () => {
    seedSession('marked');
    const update = vi.spyOn(store, 'update');

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'marked',
    });

    expect(update).toHaveBeenCalledWith(sessionPath('marked'), {
      status: 'DELETING',
    });
    expect(store.documents.has(sessionPath('marked'))).toBe(false);
  });

  it('deletes the session even when the deleting marker cannot be written', async () => {
    seedSession('marked');
    store.write(eventPath('marked', 'e1'), {
      timestamp: Timestamp.fromMillis(1),
    });
    vi.spyOn(store, 'update').mockImplementation(() => {
      throw new Error('marker write failed');
    });

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'marked',
    });

    expect(store.documents.has(sessionPath('marked'))).toBe(false);
    expect(store.documents.has(eventPath('marked', 'e1'))).toBe(false);
  });

  it('is a no-op for a session that does not exist', async () => {
    const update = vi.spyOn(store, 'update');

    await expect(
      service.deleteSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'missing',
      }),
    ).resolves.toBeUndefined();

    expect(update).not.toHaveBeenCalled();
    expect(store.batchCommitCount).toBe(0);
  });

  it('deletes more events than fit in one write batch', async () => {
    const eventCount = 501;
    seedSession('bulk');
    for (let i = 0; i < eventCount; i++) {
      store.write(eventPath('bulk', `e${i}`), {
        timestamp: Timestamp.fromMillis(i),
      });
    }

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'bulk',
    });

    expect(store.batchCommitCount).toBe(2);
    expect([...store.documents.keys()]).toEqual([]);
  });
});

describe('FirestoreSessionService.appendEvent', () => {
  let session: Session;

  beforeEach(async () => {
    session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
  });

  it('writes the event document and bumps the revision on each append', async () => {
    await service.appendEvent({session, event: newEvent({id: 'e1'})});
    expect(store.documents.has(eventPath('s1', 'e1'))).toBe(true);
    expect(storedSession('s1').revision).toBe(1);

    await service.appendEvent({session, event: newEvent({id: 'e2'})});
    expect(storedSession('s1').revision).toBe(2);
  });

  it('stores the event timestamp and owner alongside the payload', async () => {
    await service.appendEvent({
      session,
      event: newEvent({id: 'e1', timestamp: 4321}),
    });

    const document = store.documents.get(eventPath('s1', 'e1'));
    expect(document?.appName).toBe(APP_NAME);
    expect(document?.userId).toBe(USER_ID);
    expect(document?.timestamp).toEqual(Timestamp.fromMillis(4321));
    expect(storedEvent('s1', 'e1').id).toBe('e1');
  });

  it('writes nothing for a partial event', async () => {
    const before = [...store.documents.entries()];

    const event = newEvent({id: 'partial', partial: true});
    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    expect([...store.documents.entries()]).toEqual(before);
    expect(session.events).toEqual([]);
  });

  it('rejects an append to an unknown session and writes nothing', async () => {
    const unknown: Session = {...session, id: 'ghost'};
    const before = [...store.documents.entries()];

    await expect(
      service.appendEvent({session: unknown, event: newEvent({id: 'e1'})}),
    ).rejects.toThrow('Session ghost not found for appendEvent');

    expect([...store.documents.entries()]).toEqual(before);
  });

  it('splits a state delta across the three documents', async () => {
    await service.appendEvent({
      session,
      event: eventWithDelta('e1', {
        'app:theme': 'dark',
        'user:locale': 'en',
        turn: 1,
      }),
    });

    expect(store.documents.get(APP_STATE_PATH)).toEqual({theme: 'dark'});
    expect(store.documents.get(USER_STATE_PATH)).toEqual({locale: 'en'});
    expect(storedState('s1')).toEqual({turn: 1});
  });

  it('merges into shared state written by an earlier append', async () => {
    store.write(APP_STATE_PATH, {existing: 'kept'});

    await service.appendEvent({
      session,
      event: eventWithDelta('e1', {'app:theme': 'dark'}),
    });

    expect(store.documents.get(APP_STATE_PATH)).toEqual({
      existing: 'kept',
      theme: 'dark',
    });
  });

  it('never persists a temporary state delta', async () => {
    await service.appendEvent({
      session,
      event: eventWithDelta('e1', {'temp:scratch': 'x', turn: 1}),
    });

    const actions = asRecord(
      storedEvent('s1', 'e1').actions,
      'the stored event actions',
    );
    expect(actions.stateDelta).toEqual({turn: 1});
    expect(storedState('s1')).toEqual({turn: 1});
    expect(session.state).toEqual({turn: 1});
  });

  it('keeps prefixed and temporary keys off the session document', async () => {
    store.write(APP_STATE_PATH, {theme: 'dark'});
    store.write(USER_STATE_PATH, {locale: 'en'});
    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    if (!loaded) {
      expect.fail('expected the session to load');
    }
    expect(loaded.state).toEqual({'app:theme': 'dark', 'user:locale': 'en'});
    loaded.state['temp:scratch'] = 'x';

    await service.appendEvent({
      session: loaded,
      event: eventWithDelta('e1', {turn: 1}),
    });

    expect(storedState('s1')).toEqual({turn: 1});
  });

  it('persists the stored state, not a stale caller in-memory view', async () => {
    // Two callers hold the same session. The first commits `a`; the second
    // still holds a view from before that and appends `b`. Deriving the
    // persisted state from the caller's session would drop `a`.
    const first = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    const second = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    if (!first || !second) {
      expect.fail('expected both reads to load the session');
    }

    await service.appendEvent({
      session: first,
      event: eventWithDelta('e1', {a: 1}),
    });
    await service.appendEvent({
      session: second,
      event: eventWithDelta('e2', {b: 2}),
    });

    expect(storedState('s1')).toEqual({a: 1, b: 2});
  });

  it('treats a session document with no revision as revision 0', async () => {
    store.write(sessionPath('legacy'), {
      id: 'legacy',
      appName: APP_NAME,
      userId: USER_ID,
      state: JSON.stringify({}),
      updateTime: Timestamp.fromMillis(0),
    });
    const legacy = createSession({
      id: 'legacy',
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.appendEvent({session: legacy, event: newEvent({id: 'e1'})});

    expect(storedSession('legacy').revision).toBe(1);
  });

  it('updates the in-memory session', async () => {
    const event = newEvent({id: 'e1', timestamp: 9999});

    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    expect(session.events).toEqual([event]);
    expect(session.lastUpdateTime).toBe(9999);
  });

  it('replaces an event re-appended under the same id', async () => {
    await service.appendEvent({session, event: newEvent({id: 'e1'})});
    await service.appendEvent({
      session,
      event: newEvent({id: 'e1', timestamp: 5555}),
    });

    expect(session.events).toHaveLength(1);
    expect(session.events[0].timestamp).toBe(5555);
    expect(
      [...store.documents.keys()].filter((path) =>
        path.includes(`/${EVENTS_COLLECTION}/`),
      ),
    ).toEqual([eventPath('s1', 'e1')]);
  });

  it('refuses to append to a session marked for deletion', async () => {
    store.set(sessionPath('s1'), {status: 'DELETING'}, true);

    await expect(
      service.appendEvent({session, event: newEvent({id: 'e1'})}),
    ).rejects.toThrow('Session s1 is currently being deleted.');

    expect(store.documents.has(eventPath('s1', 'e1'))).toBe(false);
  });

  it('serializes concurrent appends to the same session', async () => {
    const events = Array.from({length: 5}, (_, index) =>
      newEvent({id: `e${index}`, timestamp: 1000 + index}),
    );

    await Promise.all(
      events.map((event) => service.appendEvent({session, event})),
    );

    expect(storedSession('s1').revision).toBe(events.length);
    // The appends genuinely raced: Firestore aborted and re-ran the losers.
    expect(store.transactionRetryCount).toBeGreaterThan(0);
    for (const event of events) {
      expect(store.documents.has(eventPath('s1', event.id))).toBe(true);
    }
  });

  it('lets appends to different sessions of one app proceed without contending', async () => {
    const other = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's2',
    });
    store.transactionRetryCount = 0;

    await Promise.all([
      service.appendEvent({
        session,
        event: eventWithDelta('e1', {'app:theme': 'dark'}),
      }),
      service.appendEvent({
        session: other,
        event: eventWithDelta('e2', {'app:locale': 'en'}),
      }),
    ]);

    // Only the two session documents are in the read sets, so the shared
    // app-state document cannot make unrelated sessions abort each other.
    expect(store.transactionRetryCount).toBe(0);
    expect(store.documents.get(APP_STATE_PATH)).toEqual({
      theme: 'dark',
      locale: 'en',
    });
  });
});
