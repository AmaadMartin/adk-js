/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Firestore} from '@google-cloud/firestore';
import {
  createEvent,
  createSession,
  loadOptionalPeer,
  LogLevel,
  Session,
  setLogLevel,
} from '@google/adk';
import {
  DEFAULT_ROOT_COLLECTION,
  FirestoreSessionService,
} from '@google/adk-integrations';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {FirestoreClient} from '../../src/firestore/firestore_client.js';
import {
  FIRESTORE_PEER,
  resolveClient,
} from '../../src/firestore/firestore_session_service.js';
import {
  appStatePath,
  eventPath,
  FakeFirestore,
  sessionPath,
  userStatePath,
} from './firestore_test_doubles.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session';
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

let client: FakeFirestore;

beforeAll(() => {
  setLogLevel(LogLevel.ERROR);
});

beforeEach(() => {
  client = new FakeFirestore();
});

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

function localSession(): Session {
  return createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
  });
}

function storedDoc(path: string): Record<string, unknown> {
  const doc = client.read(path);
  if (!doc) {
    expect.fail(`no document stored at ${path}`);
  }
  return doc;
}

describe('FirestoreSessionService options', () => {
  const previous = process.env[ROOT_COLLECTION_ENV_VAR];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ROOT_COLLECTION_ENV_VAR];
    } else {
      process.env[ROOT_COLLECTION_ENV_VAR] = previous;
    }
  });

  it('writes under the default root collection', async () => {
    delete process.env[ROOT_COLLECTION_ENV_VAR];
    const service = new FirestoreSessionService({client});

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(
      client.read(
        sessionPath(APP_NAME, USER_ID, session.id, DEFAULT_ROOT_COLLECTION),
      ),
    ).toBeDefined();
  });

  it('reads the root collection from the environment', async () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'from-env';
    const service = new FirestoreSessionService({client});

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(
      client.read(sessionPath(APP_NAME, USER_ID, session.id, 'from-env')),
    ).toBeDefined();
  });

  it('prefers an explicit root collection over the environment', async () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'from-env';
    const service = new FirestoreSessionService({
      client,
      rootCollection: 'explicit',
    });

    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(
      client.read(sessionPath(APP_NAME, USER_ID, session.id, 'explicit')),
    ).toBeDefined();
  });

  it('builds a default client when the caller injects none', () => {
    const built = resolveClient(undefined, {Firestore});

    expect(built).not.toBe(client);
    expect(typeof built.collection).toBe('function');
  });

  it('keeps the injected client', () => {
    expect(resolveClient(client, {Firestore})).toBe(client);
  });

  it('accepts a real Firestore client', () => {
    const accept = (candidate: FirestoreClient): FirestoreClient => candidate;
    const real = new Firestore({projectId: 'adk-parity-test'});

    expect(accept(real)).toBe(real);
  });
});

describe('the Firestore optional peer dependency', () => {
  /** The error Node raises for a package that is not installed. */
  function notInstalled(): Error {
    const error = new Error(
      "Cannot find package '@google-cloud/firestore' imported from /app/x.js",
    ) as Error & {code?: string};
    error.code = 'ERR_MODULE_NOT_FOUND';
    return error;
  }

  it('names the service and the install command when it is absent', async () => {
    const load = () => Promise.reject(notInstalled());

    await expect(loadOptionalPeer(FIRESTORE_PEER, load)).rejects.toThrow(
      /FirestoreSessionService requires the optional peer dependency "@google-cloud\/firestore"/,
    );
    await expect(loadOptionalPeer(FIRESTORE_PEER, load)).rejects.toThrow(
      /npm install @google-cloud\/firestore/,
    );
  });

  it('surfaces any other load failure unchanged', async () => {
    const broken = new Error('the module threw while evaluating');

    await expect(
      loadOptionalPeer(FIRESTORE_PEER, () => Promise.reject(broken)),
    ).rejects.toBe(broken);
  });
});

describe('FirestoreSessionService.appendEvent', () => {
  it('refuses to append to a session that is being deleted', async () => {
    seedSession({status: 'DELETING'});
    const service = new FirestoreSessionService({client});

    await expect(
      service.appendEvent({
        session: localSession(),
        event: createEvent({invocationId: 'inv', author: 'user'}),
      }),
    ).rejects.toThrow(`Session ${SESSION_ID} is currently being deleted.`);
    expect(client.writes).toEqual([]);
  });

  it('serializes two concurrent appends to the same session', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});
    const session = localSession();

    await Promise.all([
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'one', author: 'user'}),
      }),
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'two', author: 'user'}),
      }),
    ]);

    // Without the lock both transactions read revision 0 and both write 1.
    expect(
      storedDoc(sessionPath(APP_NAME, USER_ID, SESSION_ID))['revision'],
    ).toBe(2);
    expect(session.storageUpdateMarker).toBe('2');
  });

  it('reads the app state only when the event changes it', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});

    await service.appendEvent({
      session: localSession(),
      event: createEvent({
        invocationId: 'inv',
        author: 'user',
        actions: {stateDelta: {'user:seen': 1}},
      }),
    });

    expect(client.calls).not.toContain(`get:${appStatePath(APP_NAME)}`);
    expect(client.calls).toContain(`get:${userStatePath(APP_NAME, USER_ID)}`);
    expect(storedDoc(userStatePath(APP_NAME, USER_ID))['seen']).toBe(1);
  });

  it('merges an event delta into shared state that already exists', async () => {
    seedSession();
    client.put(appStatePath(APP_NAME), {kept: 'yes'});
    const service = new FirestoreSessionService({client});

    await service.appendEvent({
      session: localSession(),
      event: createEvent({
        invocationId: 'inv',
        author: 'user',
        actions: {stateDelta: {'app:added': 'new'}},
      }),
    });

    expect(storedDoc(appStatePath(APP_NAME))).toEqual({
      kept: 'yes',
      added: 'new',
    });
  });

  it('writes the event body in the snake_case wire form', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});
    const event = createEvent({invocationId: 'inv', author: 'user'});

    await service.appendEvent({session: localSession(), event});

    const doc = storedDoc(eventPath(APP_NAME, USER_ID, SESSION_ID, event.id));
    expect(doc['appName']).toBe(APP_NAME);
    expect(doc['userId']).toBe(USER_ID);
    expect(doc['event_data']).toMatchObject({invocation_id: 'inv'});
  });
});

describe('FirestoreSessionService.getSession', () => {
  it('reads a state stored as a JSON string', async () => {
    seedSession({state: JSON.stringify({from: 'json'}), revision: 4});
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.state).toEqual({from: 'json'});
    expect(session?.storageUpdateMarker).toBe('4');
  });

  it('converts a Firestore timestamp to epoch milliseconds', async () => {
    seedSession({updateTime: {toMillis: () => 1717000000000}});
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.lastUpdateTime).toBe(1717000000000);
  });

  it('reads an unwritten revision as zero', async () => {
    seedSession({revision: 'not a number'});
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.storageUpdateMarker).toBe('0');
  });

  it('reads a state that is not a record as empty', async () => {
    seedSession({state: '"just a string"'});
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.state).toEqual({});
  });

  it('reads an unusable update time as zero', async () => {
    seedSession({updateTime: 'never'});
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.lastUpdateTime).toBe(0);
  });

  it('skips an event document that carries no event data', async () => {
    seedSession();
    client.put(eventPath(APP_NAME, USER_ID, SESSION_ID, 'broken'), {
      timestamp: 1,
    });
    const service = new FirestoreSessionService({client});

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.events).toEqual([]);
  });

  it('reads back a session it created, including shared state', async () => {
    const service = new FirestoreSessionService({client});
    const created = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {'app:tier': 'gold', 'user:locale': 'en-GB', topic: 'weather'},
    });
    const event = createEvent({
      invocationId: 'inv',
      author: 'user',
      actions: {stateDelta: {topic: 'traffic'}},
    });
    await service.appendEvent({session: created, event});

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: created.id,
    });

    expect(loaded?.state).toEqual({
      'app:tier': 'gold',
      'user:locale': 'en-GB',
      topic: 'traffic',
    });
    expect(loaded?.events.map((each) => each.invocationId)).toEqual(['inv']);
    expect(loaded?.storageUpdateMarker).toBe('1');
  });
});

describe('FirestoreSessionService.deleteSession', () => {
  it('deletes the session even when the marker write fails', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});
    client.failNextTransaction = new Error('contention');

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(client.read(sessionPath(APP_NAME, USER_ID, SESSION_ID))).toBe(
      undefined,
    );
  });

  it('marks the session before deleting its events', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(client.writes).toEqual([
      {
        kind: 'update',
        path: sessionPath(APP_NAME, USER_ID, SESSION_ID),
        data: {status: 'DELETING'},
        merge: false,
      },
    ]);
  });

  it('commits no batch when the session has no events', async () => {
    seedSession();
    const service = new FirestoreSessionService({client});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(client.batches[0].commits).toBe(0);
  });

  it('does not mark a session that is not there', async () => {
    const service = new FirestoreSessionService({client});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(client.writes).toEqual([]);
  });
});

describe('FirestoreSessionService.listSessions', () => {
  beforeEach(() => {
    for (const [id, updateTime] of [
      ['a', 30],
      ['b', 10],
      ['c', 20],
    ] as const) {
      client.put(sessionPath(APP_NAME, USER_ID, id), {
        id,
        appName: APP_NAME,
        userId: USER_ID,
        state: {},
        updateTime,
      });
    }
  });

  function ids(sessions: Session[]): string[] {
    return sessions.map((session) => session.id);
  }

  it('orders by last update time and reports one page', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(ids(response.sessions)).toEqual(['b', 'c', 'a']);
    expect(response).toMatchObject({
      page: 1,
      limit: 3,
      totalItems: 3,
      totalPages: 1,
    });
  });

  it('reverses the order on request', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      order: 'desc',
    });

    expect(ids(response.sessions)).toEqual(['a', 'c', 'b']);
  });

  it('returns the requested page', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      limit: 2,
      page: 2,
    });

    expect(ids(response.sessions)).toEqual(['a']);
    expect(response).toMatchObject({
      page: 2,
      limit: 2,
      totalItems: 3,
      totalPages: 2,
    });
  });

  it('derives the page from an offset', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      limit: 2,
      offset: 2,
    });

    expect(ids(response.sessions)).toEqual(['a']);
    expect(response.page).toBe(2);
  });

  it('applies an offset without a limit', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      offset: 1,
    });

    expect(ids(response.sessions)).toEqual(['c', 'a']);
    expect(response).toMatchObject({page: 1, limit: 3, totalItems: 3});
  });

  it('reports no pages for a limit of zero', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
      limit: 0,
    });

    expect(response.sessions).toEqual([]);
    expect(response).toMatchObject({page: 1, limit: 0, totalPages: 0});
  });

  it('reports no pages when the app has no sessions', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({
      appName: 'empty_app',
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

  it('breaks a tie on user id, then on session id', async () => {
    for (const [userId, id] of [
      ['u2', 'z'],
      ['u1', 'b'],
      ['u1', 'a'],
    ] as const) {
      client.put(sessionPath(APP_NAME, userId, id), {
        id,
        appName: APP_NAME,
        userId,
        state: {},
        updateTime: 99,
      });
    }
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({appName: APP_NAME});

    expect(
      response.sessions
        .filter((session) => session.lastUpdateTime === 99)
        .map((session) => `${session.userId}/${session.id}`),
    ).toEqual(['u1/a', 'u1/b', 'u2/z']);
  });

  it('reads no user state when the app has no sessions at all', async () => {
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({appName: 'empty_app'});

    expect(response.sessions).toEqual([]);
    expect(client.calls.filter((call) => call.startsWith('getAll'))).toEqual(
      [],
    );
  });

  it('skips a collection-group document that is not a session', async () => {
    client.put(sessionPath('other_app', 'someone', 'intruder'), {
      appName: APP_NAME,
      note: 'no id and no userId',
    });
    const service = new FirestoreSessionService({client});

    const response = await service.listSessions({appName: APP_NAME});

    expect(ids(response.sessions)).toEqual(['b', 'c', 'a']);
  });
});
