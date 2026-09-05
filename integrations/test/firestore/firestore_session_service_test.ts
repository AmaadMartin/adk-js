/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour adk-js has and adk-python does not, so the ported suite in
 * `firestore_session_service_parity_test.ts` cannot cover it: millisecond
 * timestamps, the paginated `listSessions` contract, and the root-collection
 * precedence chain.
 */

import {Firestore} from '@google-cloud/firestore';
import {createEvent, createEventActions, createSession} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FakeFirestore,
  fakeFirestores,
  FakeTimestamp,
  RecordedWrite,
} from './firestore_session_test_doubles.js';

vi.mock('@google-cloud/firestore', async () => {
  const fake = await import('./firestore_session_test_doubles.js');
  return {Firestore: fake.FakeFirestore, FieldValue: fake.FakeFieldValue};
});

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

const SESSION_PATH = `adk-session/${APP_NAME}/users/${USER_ID}/sessions/${SESSION_ID}`;
const EVENTS_PATH = `${SESSION_PATH}/events`;

let client: Firestore;
let fake: FakeFirestore;
let service: FirestoreSessionService;
const originalRootCollection = process.env[ROOT_COLLECTION_ENV_VAR];

beforeEach(() => {
  fakeFirestores.length = 0;
  client = new Firestore();
  fake = fakeFirestores[0];
  service = new FirestoreSessionService({client});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRootCollection === undefined) {
    delete process.env[ROOT_COLLECTION_ENV_VAR];
  } else {
    process.env[ROOT_COLLECTION_ENV_VAR] = originalRootCollection;
  }
});

/** Seeds `count` sessions, one per user, with an ascending update time. */
function seedSessions(count: number): void {
  for (let i = 0; i < count; i++) {
    fake.seed(`adk-session/${APP_NAME}/users/u${i}/sessions/s${i}`, {
      id: `s${i}`,
      appName: APP_NAME,
      userId: `u${i}`,
      state: {},
      updateTime: 1000 + i,
    });
  }
}

function sessionUpdates(): RecordedWrite[] {
  return fake.writes.filter(
    (w) => w.kind === 'update' && w.path === SESSION_PATH,
  );
}

describe('FirestoreSessionService lastUpdateTime', () => {
  it.each([
    ['a Firestore timestamp', new FakeTimestamp(1718447400000), 1718447400000],
    ['a Date', new Date('2024-06-15T10:30:00.000Z'), 1718447400000],
    ['a raw number of milliseconds', 1718447400000, 1718447400000],
    ['an absent field', undefined, 0],
    ['a NaN written by hand', Number.NaN, 0],
    ['an infinite number written by hand', Number.POSITIVE_INFINITY, 0],
    ['a string written by hand', '2024-06-15', 0],
  ])('reads %s as milliseconds', async (_label, updateTime, expected) => {
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: {},
      updateTime,
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.lastUpdateTime).toBe(expected);
  });
});

describe('FirestoreSessionService listSessions pagination', () => {
  beforeEach(() => {
    seedSessions(5);
  });

  it('returns every session when no pagination is requested', async () => {
    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions.map((s) => s.id)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's4',
    ]);
    expect(response).toMatchObject({
      page: 1,
      limit: 5,
      totalItems: 5,
      totalPages: 1,
    });
  });

  it('slices to the first page when only a limit is given', async () => {
    const response = await service.listSessions({appName: APP_NAME, limit: 2});

    expect(response.sessions.map((s) => s.id)).toEqual(['s0', 's1']);
    expect(response).toMatchObject({
      page: 1,
      limit: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });

  it('slices to the requested page when a limit and a page are given', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      limit: 2,
      page: 2,
    });

    expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(response).toMatchObject({
      page: 2,
      limit: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });

  it('derives the page from the offset when a limit and an offset are given', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      limit: 2,
      offset: 3,
    });

    expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(response).toMatchObject({
      page: 2,
      limit: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });

  it('skips the offset and reports one page when no limit is given', async () => {
    const response = await service.listSessions({appName: APP_NAME, offset: 3});

    expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(response).toMatchObject({
      page: 1,
      limit: 5,
      totalItems: 5,
      totalPages: 1,
    });
  });

  it('reports zero pages when nothing matches', async () => {
    const response = await service.listSessions({appName: 'no_such_app'});

    expect(response.sessions).toEqual([]);
    expect(response).toMatchObject({
      page: 1,
      limit: 0,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('returns nothing and reports no pages for a limit of zero', async () => {
    const response = await service.listSessions({appName: APP_NAME, limit: 0});

    expect(response.sessions).toEqual([]);
    expect(response).toMatchObject({
      page: 1,
      limit: 0,
      totalItems: 5,
      totalPages: 0,
    });
  });

  it('reverses the order for order: desc', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      order: 'desc',
      limit: 2,
    });

    expect(response.sessions.map((s) => s.id)).toEqual(['s4', 's3']);
  });

  it('keeps the ascending order for order: asc', async () => {
    const response = await service.listSessions({
      appName: APP_NAME,
      order: 'asc',
      limit: 2,
    });

    expect(response.sessions.map((s) => s.id)).toEqual(['s0', 's1']);
  });
});

/** Three sessions sharing one update time, listed in their sorted order. */
const TIED_SESSIONS = [
  {userId: 'u0', id: 'a'},
  {userId: 'u0', id: 'b'},
  {userId: 'u1', id: 'c'},
];

describe('FirestoreSessionService listSessions ordering', () => {
  it.each([
    ['document order', TIED_SESSIONS],
    ['reverse document order', [...TIED_SESSIONS].reverse()],
  ])(
    'breaks a tie on update time by user then by id, seeded in %s',
    async (_label, seeds) => {
      for (const seed of seeds) {
        fake.seed(
          `adk-session/${APP_NAME}/users/${seed.userId}/sessions/${seed.id}`,
          {
            id: seed.id,
            appName: APP_NAME,
            userId: seed.userId,
            state: {},
            updateTime: 500,
          },
        );
      }
      fake.seed(`adk-session/${APP_NAME}/users/u9/sessions/late`, {
        id: 'late',
        appName: APP_NAME,
        userId: 'u9',
        state: {},
        updateTime: 900,
      });

      const response = await service.listSessions({appName: APP_NAME});

      expect(response.sessions.map((s) => `${s.userId}/${s.id}`)).toEqual([
        'u0/a',
        'u0/b',
        'u1/c',
        'u9/late',
      ]);
    },
  );

  it('reads every listed user state in one batch', async () => {
    const getAll = vi.spyOn(fake, 'getAll');
    seedSessions(3);
    fake.seed(`user_states/${APP_NAME}/users/u1`, {tier: 'pro'});

    const response = await service.listSessions({appName: APP_NAME});

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(response.sessions[1].state['user:tier']).toBe('pro');
    expect(response.sessions[0].state).not.toHaveProperty('user:tier');
  });

  it('tolerates a session document that is missing its identifiers', async () => {
    fake.seed(`adk-session/${APP_NAME}/users/u0/sessions/orphan`, {
      appName: APP_NAME,
      state: {turn: 1},
    });

    const response = await service.listSessions({appName: APP_NAME});

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]).toMatchObject({
      id: '',
      userId: '',
      appName: APP_NAME,
    });
    expect(response.sessions[0].state['turn']).toBe(1);
  });

  it('reads no user state at all when nothing matches', async () => {
    const getAll = vi.spyOn(fake, 'getAll');

    await service.listSessions({appName: APP_NAME});

    expect(getAll).not.toHaveBeenCalled();
  });
});

describe('FirestoreSessionService root collection', () => {
  it('prefers the explicit option', () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'from_env';

    expect(
      new FirestoreSessionService({client, rootCollection: 'explicit'})
        .rootCollection,
    ).toBe('explicit');
  });

  it('falls back to the environment variable', () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'from_env';

    expect(new FirestoreSessionService({client}).rootCollection).toBe(
      'from_env',
    );
  });

  it('falls through an empty option to the environment variable', () => {
    process.env[ROOT_COLLECTION_ENV_VAR] = 'from_env';

    expect(
      new FirestoreSessionService({client, rootCollection: ''}).rootCollection,
    ).toBe('from_env');
  });

  it('defaults to adk-session', () => {
    delete process.env[ROOT_COLLECTION_ENV_VAR];

    expect(new FirestoreSessionService({client}).rootCollection).toBe(
      'adk-session',
    );
  });

  it('writes under the configured root collection', async () => {
    const custom = new FirestoreSessionService({
      client,
      rootCollection: 'other-root',
    });

    const session = await custom.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(
      fake.documents.has(
        `other-root/${APP_NAME}/users/${USER_ID}/sessions/${session.id}`,
      ),
    ).toBe(true);
  });
});

describe('FirestoreSessionService client construction', () => {
  it('builds one client and reuses it across calls', async () => {
    fakeFirestores.length = 0;
    const lazy = new FirestoreSessionService();

    await lazy.listSessions({appName: APP_NAME});
    await lazy.listSessions({appName: APP_NAME});

    expect(fakeFirestores).toHaveLength(1);
  });

  it('builds no client when one is supplied', async () => {
    fakeFirestores.length = 0;

    await service.listSessions({appName: APP_NAME});

    expect(fakeFirestores).toHaveLength(0);
  });
});

describe('FirestoreSessionService appendEvent', () => {
  beforeEach(() => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
  });

  it('serializes two appends racing on one session', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await Promise.all([
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'a', author: 'user'}),
      }),
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'b', author: 'user'}),
      }),
    ]);

    expect(sessionUpdates().map((w) => w.data['revision'])).toEqual([1, 2]);
    expect(session.storageUpdateMarker).toBe('2');
  });

  it('treats a session document with no revision field as revision zero', async () => {
    fake.documents.delete(SESSION_PATH);
    fake.seed(SESSION_PATH, {id: SESSION_ID});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.appendEvent({
      session,
      event: createEvent({invocationId: 'a', author: 'user'}),
    });

    expect(sessionUpdates().map((w) => w.data['revision'])).toEqual([1]);
  });

  it('writes an event whose actions carry no state delta', async () => {
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: {kept: 'yes'},
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'a',
        author: 'user',
        actions: {stateDelta: undefined},
      }),
    });

    const update = sessionUpdates()[0];
    expect(update.data['revision']).toBe(1);
    expect(JSON.parse(String(update.data['state']))).toEqual({kept: 'yes'});
  });

  it('rejects an append to a session that is being deleted', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0, status: 'DELETING'});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await expect(
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'a', author: 'user'}),
      }),
    ).rejects.toThrow(`Session ${SESSION_ID} is currently being deleted.`);
    expect(fake.writes).toEqual([]);
  });

  it('keeps the other keys when one state value is circular', async () => {
    const loop: Record<string, unknown> = {name: 'loop'};
    loop['self'] = loop;
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'a',
        author: 'user',
        actions: createEventActions({stateDelta: {loop, ok: 1}}),
      }),
    });

    const state = JSON.parse(
      String(sessionUpdates()[0].data['state']),
    ) as Record<string, unknown>;
    expect(state['ok']).toBe(1);
    // Only the back-reference is replaced, so the rest of the object survives.
    expect(state['loop']).toEqual({name: 'loop', self: '[Circular]'});
  });
});

describe('FirestoreSessionService cross-SDK event format', () => {
  // Captured verbatim from adk-python:
  //   Event(invocation_id='py_inv', author='py_user',
  //         actions=EventActions(state_delta={'session_key': 'session_val'}))
  //     .model_dump(exclude_none=True, mode='json')
  // Its `Event` sets alias_generator=to_camel without serialize_by_alias, so
  // `model_dump` writes the field names, which are snake_case.
  const PYTHON_EVENT_DOCUMENT = {
    invocation_id: 'py_inv',
    author: 'py_user',
    actions: {
      state_delta: {session_key: 'session_val'},
      artifact_delta: {},
      requested_auth_configs: {},
      requested_tool_confirmations: {},
    },
    node_info: {path: ''},
    id: '71d9e6a0-cf33-42d4-b1e4-5cc474e572a8',
    timestamp: 1788614765.9920907,
  };

  it('reads an event adk-python wrote', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, appName: APP_NAME});
    fake.seed(`${EVENTS_PATH}/py`, {
      event_data: PYTHON_EVENT_DOCUMENT,
      timestamp: new FakeTimestamp(1),
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const event = session?.events[0];
    expect(event?.invocationId).toBe('py_inv');
    expect(event?.author).toBe('py_user');
    // The delta's own keys are caller data and survive verbatim.
    expect(event?.actions.stateDelta).toEqual({session_key: 'session_val'});
  });

  it('writes an event adk-python can read', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, revision: 0});
    const session = createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });
    const event = createEvent({
      invocationId: 'js_inv',
      author: 'js_user',
      actions: createEventActions({stateDelta: {session_key: 'session_val'}}),
    });

    await service.appendEvent({session, event});

    const stored = fake.writes.find(
      (w) => w.kind === 'set' && w.path === `${EVENTS_PATH}/${event.id}`,
    )?.data['event_data'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored)).toContain('invocation_id');
    expect(Object.keys(stored)).not.toContain('invocationId');
    expect(stored['invocation_id']).toBe('js_inv');
    expect(stored['actions']['state_delta']).toEqual({
      session_key: 'session_val',
    });
  });
});

describe('FirestoreSessionService getSession', () => {
  it('parses a state field stored as JSON text', async () => {
    fake.seed(SESSION_PATH, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: JSON.stringify({turn: 3}),
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.state).toEqual({turn: 3});
  });

  it('skips an event document that carries no event_data', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, appName: APP_NAME});
    fake.seed(`${EVENTS_PATH}/broken`, {timestamp: new FakeTimestamp(1)});
    fake.seed(`${EVENTS_PATH}/good`, {
      event_data: {invocationId: 'inv', author: 'user'},
      timestamp: new FakeTimestamp(2),
    });

    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(session?.events.map((e) => e.invocationId)).toEqual(['inv']);
  });

  it('applies afterTimestamp without a limit when no count is given', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID, appName: APP_NAME});

    await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {afterTimestamp: 5},
    });

    const onEvents = fake.queryCalls.filter((c) => c.source === EVENTS_PATH);
    expect(onEvents.filter((c) => c.method === 'where')).toHaveLength(1);
    expect(onEvents.filter((c) => c.method === 'limitToLast')).toEqual([]);
  });
});

describe('FirestoreSessionService deleteSession', () => {
  it('deletes the session even when the deleting marker cannot be written', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID});
    vi.spyOn(fake, 'runTransaction').mockRejectedValueOnce(
      new Error('transaction unavailable'),
    );

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(fake.documents.has(SESSION_PATH)).toBe(false);
  });

  it('commits no batch when the session has no events', async () => {
    fake.seed(SESSION_PATH, {id: SESSION_ID});

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(fake.batchCommits).toBe(0);
    expect(fake.deletedPaths).toEqual([SESSION_PATH]);
  });
});
