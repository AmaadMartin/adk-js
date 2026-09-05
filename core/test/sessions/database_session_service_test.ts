/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  createEvent,
  createEventActions,
  createSession,
  DatabaseSessionService,
  Event,
  InputValidationError,
  Session,
  SessionNotFoundError,
  StaleSessionError,
  State,
} from '@google/adk';
import {EntityManager, LockMode, MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {isDatabaseConnectionString} from '../../src/sessions/database_session_service.js';
import {sessionLockMode} from '../../src/sessions/db/dialect.js';
import {
  dialectOf,
  ensureDatabaseCreated,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  validateDatabaseSchemaVersion,
} from '../../src/sessions/db/operations.js';
import {
  ENTITIES,
  METADATA_TABLE_NAME,
  StorageAppState,
  StorageSession,
  StorageUserState,
} from '../../src/sessions/db/schema.js';
import {ENTITIES_V0, StorageEventV0} from '../../src/sessions/db/schema_v0.js';
import {logger} from '../../src/utils/logger.js';

// The read/write split is observable only through which fork the service
// asks for, so those two seams and the backend probe are spied on while every
// other export keeps its real behaviour.
vi.mock('../../src/sessions/db/operations.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/sessions/db/operations.js')
    >();
  return {
    ...original,
    forkForRead: vi.fn(original.forkForRead),
    forkForWrite: vi.fn(original.forkForWrite),
    getDatabaseBackend: vi.fn(original.getDatabaseBackend),
  };
});

/** Opens a service that records every statement MikroORM sends. */
async function createLoggingService(): Promise<{
  service: DatabaseSessionService;
  queries: string[];
}> {
  const queries: string[] = [];
  const service = new DatabaseSessionService({
    dbName: ':memory:',
    driver: SqliteDriver,
    allowGlobalContext: true,
    debug: ['query'],
    logger: (message: string) => queries.push(message),
  });
  await service.init();
  return {service, queries};
}

/** Reports whether a logged statement reads the events table. */
function readsEventsTable(query: string): boolean {
  return /select .* from .?events.?/.test(query);
}

/** Counts the rows left in a legacy database's events table. */
async function countLegacyEvents(databaseFile: string): Promise<number> {
  const orm = await MikroORM.init({
    dbName: databaseFile,
    driver: SqliteDriver,
    entities: ENTITIES_V0,
    pool: {min: 1, max: 1},
  });
  const remaining = await orm.em.fork().count(StorageEventV0, {});
  await orm.close();
  return remaining;
}

/** Appends `count` events, one millisecond apart, to an existing session. */
async function appendEvents(
  service: DatabaseSessionService,
  session: Session,
  count: number,
): Promise<void> {
  const start = Date.now();
  for (let index = 0; index < count; index++) {
    await service.appendEvent({
      session,
      event: createEvent({timestamp: start + index}),
    });
  }
}

describe('DatabaseSessionService', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true, // simplified for tests
    });
    await service.init();
  });

  afterEach(async () => {
    await service.close();
  });

  it('should create a session', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      state: {'foo': 'bar'},
      sessionId: 'test-session-id',
    });

    expect(session.id).toBe('test-session-id');
    expect(session.appName).toBe('test-app');
    expect(session.userId).toBe('test-user');
    expect(session.state['foo']).toBe('bar');
  });

  it('should filter out temporary state keys prefixed with temp: on creation', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      state: {
        'foo': 'bar',
        [`${State.TEMP_PREFIX}temp`]: 'value',
      },
      sessionId: 'test-session-id-2',
    });

    expect(session.id).toBe('test-session-id-2');
    expect(session.state['foo']).toBe('bar');
    expect(session.state[`${State.TEMP_PREFIX}temp`]).toBeUndefined();
  });

  it('should get a session', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
      state: {'key': 'value'},
    });

    const session = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
    });

    expect(session).toBeDefined();
    expect(session?.id).toBe('test-session-id');
    expect(session?.state['key']).toBe('value');
  });

  it('should list sessions', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's2',
    });

    const response = await service.listSessions({
      appName: 'test-app',
      userId: 'test-user',
    });

    expect(response.sessions.length).toBe(2);
    const ids = response.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('should delete a session', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    await service.deleteSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    const session = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    expect(session).toBeUndefined();
  });

  it('should append event and update state', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
      state: {'count': 0},
    });

    const event: Event = createEvent({
      timestamp: Date.now(),
      actions: {
        stateDelta: {'count': 1, [State.APP_PREFIX + 'global']: 'value'},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    });

    await service.appendEvent({session, event});

    expect(session.state['count']).toBe(1);
    expect(session.state[State.APP_PREFIX + 'global']).toBe('value');

    // Verify persistence
    const loadedSession = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    expect(loadedSession?.state['count']).toBe(1);
    expect(loadedSession?.state[State.APP_PREFIX + 'global']).toBe('value');
    expect(loadedSession?.events.length).toBe(1);
  });

  it('should persist app state across sessions', async () => {
    // Create first session and update app state
    await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      state: {[State.APP_PREFIX + 'config']: 'dark-mode'},
    });

    // Create second session for same app but different user
    const s2 = await service.createSession({
      appName: 'test-app',
      userId: 'user2',
      sessionId: 's2',
    });

    expect(s2.state[State.APP_PREFIX + 'config']).toBe('dark-mode');

    // Update app state in s2 via appendEvent
    const event = createEvent({
      timestamp: Date.now(),
      actions: createEventActions({
        stateDelta: {[State.APP_PREFIX + 'config']: 'light-mode'},
      }),
    });
    await service.appendEvent({session: s2, event});

    // Verify s1 sees the update when re-fetched
    const s1Reloaded = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    expect(s1Reloaded?.state[State.APP_PREFIX + 'config']).toBe('light-mode');
  });

  it('should persist user state across sessions', async () => {
    // Session 1 for user1
    await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      state: {[State.USER_PREFIX + 'pref']: 'A'},
    });

    // Session 2 for same user
    const s2 = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's2',
    });

    expect(s2.state[State.USER_PREFIX + 'pref']).toBe('A');

    // Update user state in s2
    const event = createEvent({
      timestamp: Date.now(),
      actions: createEventActions({
        stateDelta: {[State.USER_PREFIX + 'pref']: 'B'},
      }),
    });
    await service.appendEvent({session: s2, event});

    // Verify s1 sees update
    const s1Reloaded = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    expect(s1Reloaded?.state[State.USER_PREFIX + 'pref']).toBe('B');

    // Verify another user doesn't see it
    const s3 = await service.createSession({
      appName: 'test-app',
      userId: 'user2',
      sessionId: 's3',
    });
    expect(s3.state[State.USER_PREFIX + 'pref']).toBeUndefined();
  });

  it('should filter events in getSession', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });

    const now = Date.now();
    const e1 = createEvent({timestamp: now - 1000});
    const e2 = createEvent({timestamp: now});
    const e3 = createEvent({timestamp: now + 1000});

    await service.appendEvent({session, event: e1});
    await service.appendEvent({session, event: e2});
    await service.appendEvent({session, event: e3});

    // Test numRecentEvents
    const recent = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {numRecentEvents: 2},
    });
    expect(recent?.events.length).toBe(2);
    expect(recent?.events[0].id).toBe(e2.id);
    expect(recent?.events[1].id).toBe(e3.id);

    // Test afterTimestamp
    const after = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {afterTimestamp: now - 100},
    });
    expect(after?.events.length).toBe(2);
    expect(after?.events[0].id).toBe(e2.id);
    expect(after?.events[1].id).toBe(e3.id);

    // Test afterTimestamp. It is inclusive, so e2 comes back with e3.
    const after2 = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {afterTimestamp: now},
    });
    expect(after2?.events.length).toBe(2);
    expect(after2?.events[0].id).toBe(e2.id);
    expect(after2?.events[1].id).toBe(e3.id);
  });

  it('includes the event whose timestamp equals afterTimestamp', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'boundary',
    });

    const boundary = Date.now();
    const before = createEvent({timestamp: boundary - 1});
    const onBoundary = createEvent({timestamp: boundary});
    const after = createEvent({timestamp: boundary + 1});
    for (const event of [before, onBoundary, after]) {
      await service.appendEvent({session, event});
    }

    const retrieved = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'boundary',
      config: {afterTimestamp: boundary},
    });

    expect(retrieved?.events.map((event) => event.id)).toEqual([
      onBoundary.id,
      after.id,
    ]);
  });

  it('skips the events query when numRecentEvents is zero', async () => {
    const {service: logged, queries} = await createLoggingService();
    const session = await logged.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'metadata-only',
      state: {'greeting': 'hi'},
    });
    await appendEvents(logged, session, 3);

    queries.length = 0;
    const retrieved = await logged.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'metadata-only',
      config: {numRecentEvents: 0},
    });

    expect(queries.filter(readsEventsTable)).toEqual([]);
    expect(retrieved?.events).toEqual([]);
    expect(retrieved?.state['greeting']).toBe('hi');
    await logged.close();
  });

  it('reads every event when numRecentEvents is omitted', async () => {
    const {service: logged, queries} = await createLoggingService();
    const session = await logged.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'all-events',
    });
    await appendEvents(logged, session, 3);

    queries.length = 0;
    const retrieved = await logged.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 'all-events',
    });

    expect(queries.filter(readsEventsTable).length).toBe(1);
    expect(retrieved?.events.length).toBe(3);
    await logged.close();
  });

  it('should filter sessions by userId in listSessions', async () => {
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.createSession({
      appName: 'app1',
      userId: 'u2',
      sessionId: 's2',
    });
    await service.createSession({
      appName: 'app2', // Diff app
      userId: 'u1',
      sessionId: 's3',
    });

    const listU1 = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listU1.sessions.length).toBe(1);
    expect(listU1.sessions[0].id).toBe('s1');

    const listAll = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listAll.sessions.length).toBe(1);
  });

  it('should handle errors', async () => {
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });

    // Test duplicate creation
    await expect(
      service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      }),
    ).rejects.toThrow('Session with id s1 already exists');

    // Test requesting non-existent session
    const noSession = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'ghost',
    });
    expect(noSession).toBeUndefined();

    // Test append to non-existent session
    const ghostSession = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'temp',
    });
    // Manually change ID to simulate object mismatch or stale ref
    ghostSession.id = 'missing';
    const event = createEvent();

    await expect(
      service.appendEvent({session: ghostSession, event}),
    ).rejects.toThrow('Session missing not found');
  });

  it('should fail with incompatible schema version', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      allowGlobalContext: true,
    });
    await ensureDatabaseCreated(orm);

    // Manually insert bad version
    const em = orm.em.fork();
    await em.nativeDelete('StorageMetadata', {key: 'schema_version'});
    await em.insert('StorageMetadata', {
      key: 'schema_version',
      value: '999',
    });

    // Reuse the same ORM/DB connection if possible or create new one on same DB
    // With :memory:, each new ORM instance is a new DB unless we share the connection.
    // So we must reuse the service or simulate check on the same instance.
    // Re-check schema version
    await expect(validateDatabaseSchemaVersion(orm)).rejects.toThrow(
      'ADK Database schema version 999 is not compatible',
    );

    await orm.close();
  });

  describe('listSessions pagination and sorting', () => {
    const appName = 'test-app';
    const userId = 'test-user';

    it('no pagination params → returns all sessions with page=1', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});
      await service.createSession({appName, userId, sessionId: 's2'});

      const response = await service.listSessions({appName, userId});

      expect(response.sessions).toHaveLength(2);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('order desc returns newest-first', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      const s3 = await service.createSession({
        appName,
        userId,
        sessionId: 's3',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 2000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'desc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('order asc returns oldest-first', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      const s3 = await service.createSession({
        appName,
        userId,
        sessionId: 's3',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 2000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    });

    it('limit returns only N sessions with correct metadata', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        limit: 3,
        order: 'asc',
      });

      expect(response.sessions).toHaveLength(3);
      expect(response.totalItems).toBe(5);
      expect(response.totalPages).toBe(2);
      expect(response.limit).toBe(3);
    });

    it('page + limit returns correct slice', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        page: 2,
        limit: 2,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
      expect(response.page).toBe(2);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(5);
      expect(response.totalPages).toBe(3);
    });

    it('offset skips N sessions', async () => {
      for (let i = 1; i <= 4; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 2,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    });

    it('offset beyond total → empty sessions with correct metadata', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 10,
      });

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(1);
    });

    it('limit=0 returns empty sessions and totalPages=0', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({appName, userId, limit: 0});

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(0);
    });

    it('order without limit returns all sessions sorted with page=1', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 2000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'desc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('page takes precedence over offset when both are provided', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        page: 2,
        limit: 2,
        offset: 0,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
      expect(response.page).toBe(2);
    });

    it('orders oldest-first when order is omitted', async () => {
      for (const [sessionId, timestamp] of [
        ['s1', 3000],
        ['s2', 1000],
        ['s3', 2000],
      ] as const) {
        const session = await service.createSession({
          appName,
          userId,
          sessionId,
        });
        await service.appendEvent({session, event: createEvent({timestamp})});
      }

      const response = await service.listSessions({appName, userId});

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('breaks an update-time tie on user id, then session id', async () => {
      const tied = 5000;
      for (const [tieUserId, sessionId] of [
        ['u2', 's2'],
        ['u1', 's3'],
        ['u1', 's1'],
      ] as const) {
        const session = await service.createSession({
          appName,
          userId: tieUserId,
          sessionId,
        });
        await service.appendEvent({
          session,
          event: createEvent({timestamp: tied}),
        });
      }

      const response = await service.listSessions({appName});

      expect(
        response.sessions.map((session) => [session.userId, session.id]),
      ).toEqual([
        ['u1', 's1'],
        ['u1', 's3'],
        ['u2', 's2'],
      ]);
    });

    it('returns the same order on repeated calls', async () => {
      const tied = 7000;
      for (const sessionId of ['s3', 's1', 's2']) {
        const session = await service.createSession({
          appName,
          userId,
          sessionId,
        });
        await service.appendEvent({
          session,
          event: createEvent({timestamp: tied}),
        });
      }

      const first = await service.listSessions({appName, userId});
      const second = await service.listSessions({appName, userId});

      expect(first.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
      expect(second.sessions.map((s) => s.id)).toEqual(
        first.sessions.map((s) => s.id),
      );
    });

    it('partitions tied sessions across pages without a gap or a repeat', async () => {
      const tied = 9000;
      for (const sessionId of ['s4', 's2', 's1', 's3']) {
        const session = await service.createSession({
          appName,
          userId,
          sessionId,
        });
        await service.appendEvent({
          session,
          event: createEvent({timestamp: tied}),
        });
      }

      const firstPage = await service.listSessions({
        appName,
        userId,
        limit: 2,
        page: 1,
      });
      const secondPage = await service.listSessions({
        appName,
        userId,
        limit: 2,
        page: 2,
      });

      expect(firstPage.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(secondPage.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    });
  });

  describe('listSessions ordering', () => {
    const appName = 'ordering-app';

    async function createSessionAt(
      userId: string,
      sessionId: string,
      updateTime: number,
    ): Promise<void> {
      const session = await service.createSession({appName, userId, sessionId});
      await service.appendEvent({
        session,
        event: createEvent({timestamp: updateTime}),
      });
    }

    it('returns sessions oldest-first when order is omitted', async () => {
      // Insertion order differs from update-time order, so an unordered query
      // cannot pass by accident.
      await createSessionAt('u1', 's-a', 2000);
      await createSessionAt('u1', 's-b', 3000);
      await createSessionAt('u1', 's-c', 1000);

      const response = await service.listSessions({appName, userId: 'u1'});

      expect(response.sessions.map((s) => s.id)).toEqual(['s-c', 's-a', 's-b']);
    });

    it('breaks a tie on user id and then session id, in both directions', async () => {
      await createSessionAt('u2', 's-b', 5000);
      await createSessionAt('u1', 's-z', 5000);
      await createSessionAt('u1', 's-a', 5000);
      await createSessionAt('u2', 's-a', 5000);
      const tieBroken = ['s-a', 's-z', 's-a', 's-b'];

      const ascending = await service.listSessions({appName});
      const descending = await service.listSessions({appName, order: 'desc'});

      expect(ascending.sessions.map((s) => s.id)).toEqual(tieBroken);
      expect(ascending.sessions.map((s) => s.userId)).toEqual([
        'u1',
        'u1',
        'u2',
        'u2',
      ]);
      expect(descending.sessions.map((s) => s.id)).toEqual(tieBroken);
    });

    it('filters on an empty user id rather than dropping the filter', async () => {
      await createSessionAt('u1', 's-a', 1000);

      const response = await service.listSessions({appName, userId: ''});

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(0);
    });
  });

  describe('getSession event query', () => {
    const appName = 'events-app';
    const userId = 'u1';
    const sessionId = 's1';

    async function appendAt(timestamps: number[]): Promise<Event[]> {
      const session = await service.createSession({
        appName,
        userId,
        sessionId,
      });
      const events = timestamps.map((timestamp) => createEvent({timestamp}));
      for (const event of events) {
        await service.appendEvent({session, event});
      }
      return events;
    }

    it('returns no events for numRecentEvents: 0', async () => {
      await appendAt([1000, 2000]);

      const session = await service.getSession({
        appName,
        userId,
        sessionId,
        config: {numRecentEvents: 0},
      });

      expect(session).toBeDefined();
      expect(session?.events).toEqual([]);
    });

    it('never queries the events table for numRecentEvents: 0', async () => {
      const statements: string[] = [];
      const orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        allowGlobalContext: true,
        debug: ['query'],
        logger: (message) => statements.push(message),
      });
      const quiet = new DatabaseSessionService(orm);
      const session = await quiet.createSession({
        appName,
        userId,
        sessionId,
      });
      await quiet.appendEvent({
        session,
        event: createEvent({timestamp: 1000}),
      });
      statements.length = 0;

      const loaded = await quiet.getSession({
        appName,
        userId,
        sessionId,
        config: {numRecentEvents: 0},
      });

      expect(loaded?.events).toEqual([]);
      expect(statements.filter((sql) => sql.includes('`events`'))).toEqual([]);
      // The read did run, so the assertion above is not vacuous.
      expect(
        statements.filter((sql) => sql.includes('`sessions`')).length,
      ).toBeGreaterThan(0);

      await orm.close();
    });

    it('includes an event whose timestamp equals afterTimestamp', async () => {
      const [, e2] = await appendAt([1000, 2000]);

      const session = await service.getSession({
        appName,
        userId,
        sessionId,
        config: {afterTimestamp: 2000},
      });

      expect(session?.events.map((e) => e.id)).toEqual([e2.id]);
    });

    it('applies afterTimestamp before numRecentEvents', async () => {
      const [, , e3, e4] = await appendAt([1000, 2000, 3000, 4000]);

      const session = await service.getSession({
        appName,
        userId,
        sessionId,
        config: {afterTimestamp: 2000, numRecentEvents: 2},
      });

      expect(session?.events.map((e) => e.id)).toEqual([e3.id, e4.id]);
    });

    it('returns tied events in the same order on every read', async () => {
      const tied = await appendAt([7000, 7000]);
      const expected = tied.map((e) => e.id).sort();

      const reads: string[][] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const session = await service.getSession({
          appName,
          userId,
          sessionId,
        });
        if (!session) {
          expect.fail('expected the session to exist');
        }
        reads.push(session.events.map((e) => e.id));
      }

      expect(reads).toEqual([expected, expected, expected]);
    });

    it('picks the same tied event for numRecentEvents: 1 on every read', async () => {
      const tied = await appendAt([7000, 7000]);
      const newest = tied.map((e) => e.id).sort()[1];

      const picks: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const session = await service.getSession({
          appName,
          userId,
          sessionId,
          config: {numRecentEvents: 1},
        });
        if (!session) {
          expect.fail('expected the session to exist');
        }
        picks.push(session.events[0].id);
      }

      expect(picks).toEqual([newest, newest, newest]);
    });
  });

  describe('Alignment Verification', () => {
    it('should trim temp state from event before persistence', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-temp',
      });

      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            'keep': 'me',
            [State.TEMP_PREFIX + 'hide']: 'me',
          },
        }),
      });

      await service.appendEvent({session, event});

      const stored = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-temp',
      });
      const eventData = stored!.events[0];

      expect(eventData.actions?.stateDelta?.['keep']).toBe('me');
      expect(
        eventData.actions?.stateDelta?.[State.TEMP_PREFIX + 'hide'],
      ).toBeUndefined();
    });

    it('should overwrite a stored event when the same id is appended twice', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-upsert',
      });

      await service.appendEvent({
        session,
        event: createEvent({id: 'e1', timestamp: 1000, author: 'user'}),
      });
      await service.appendEvent({
        session,
        event: createEvent({id: 'e1', timestamp: 2000, author: 'model'}),
      });

      const reloaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-upsert',
      });

      expect(reloaded?.events).toHaveLength(1);
      expect(reloaded?.events[0].timestamp).toBe(2000);
      expect(reloaded?.events[0].author).toBe('model');
    });

    it('should align session updateTime with event timestamp', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-time',
      });

      const timestamp = 1234567890000;
      const event = createEvent({timestamp});

      await service.appendEvent({session, event});

      expect(session.lastUpdateTime).toBe(timestamp);

      const stored = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-time',
      });

      expect(stored?.lastUpdateTime).toBe(timestamp);
    });
  });

  describe('Stale Writer Detection', () => {
    /** The update time a fresh read of the same session reports. */
    async function reloadedUpdateTime(sessionId: string): Promise<number> {
      const reloaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId,
      });
      if (!reloaded) {
        return expect.fail(`session ${sessionId} was not stored`);
      }
      return reloaded.lastUpdateTime;
    }

    it('should report the stored update time on a created session', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-created',
      });

      expect(session.lastUpdateTime).toBeGreaterThan(0);
      expect(await reloadedUpdateTime('s-created')).toBe(
        session.lastUpdateTime,
      );
    });

    it('should move the update time to the appended event', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-appended',
      });
      const created = session.lastUpdateTime;

      await service.appendEvent({
        session,
        event: createEvent({id: 'e1', timestamp: 1234567890000}),
      });

      expect(session.lastUpdateTime).not.toBe(created);
      expect(await reloadedUpdateTime('s-appended')).toBe(1234567890000);
    });

    // These two cases arrived asserting that `appendEvent` reloads a session
    // storage moved under. On this branch it throws StaleSessionError instead,
    // because the stale-session PR replaced the reload with an explicit error.
    // The scenarios below are the ones this pull request added, and they still
    // prove what it set out to prove: the service sees an update time that
    // moved either way. The outcome they assert is the one this branch now has.
    it('should detect a stored update time that moved backwards', async () => {
      const writer = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-backwards',
      });
      const reader = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-backwards',
      });
      if (!reader) {
        return expect.fail('the session was not found');
      }

      // appendEvent sets update_time to the event's timestamp, so the writer
      // leaves it BEHIND the reader's own. A later-than comparison misses it.
      await service.appendEvent({
        session: writer,
        event: createEvent({
          id: 'e1',
          timestamp: 1000,
          actions: createEventActions({stateDelta: {'written': 'by-writer'}}),
        }),
      });
      expect(writer.lastUpdateTime).toBeLessThan(reader.lastUpdateTime);

      await expect(
        service.appendEvent({
          session: reader,
          event: createEvent({id: 'e2', timestamp: 2000}),
        }),
      ).rejects.toBeInstanceOf(StaleSessionError);
    });

    it('should accept a hand-built session that has no update time', async () => {
      await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-hand-built',
        state: {'stored': 'value'},
      });
      const handWritten = createSession({
        id: 's-hand-built',
        appName: 'test-app',
        userId: 'test-user',
        lastUpdateTime: 0,
      });

      await service.appendEvent({
        session: handWritten,
        event: createEvent({id: 'e1', timestamp: 2000}),
      });

      expect(handWritten.lastUpdateTime).toBe(2000);
      // The write keeps the state the session row already held.
      const reloaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-hand-built',
      });
      expect(reloaded?.state['stored']).toBe('value');
      expect(reloaded?.events.map((e) => e.id)).toEqual(['e1']);
    });
  });

  describe('non-serializable session state', () => {
    it('persists an event whose stateDelta holds a function', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'serializable-session',
      });
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {ok: 2, cb: () => 1},
        }),
      });

      await service.appendEvent({session, event});

      const loaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'serializable-session',
      });
      expect(loaded?.events.length).toBe(1);
      expect(loaded?.events[0].actions.stateDelta['ok']).toBe(2);
      expect(loaded?.events[0].actions.stateDelta['cb']).toEqual(
        expect.stringContaining('Function'),
      );
    });
  });

  describe('getUserState', () => {
    it('returns an empty object before any user state is written', async () => {
      const state = await service.getUserState({
        appName: 'app',
        userId: 'alice',
      });

      expect(state).toEqual({});
    });

    it('returns un-prefixed user keys written through appendEvent', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'alice',
        sessionId: 'sid',
      });
      await service.appendEvent({
        session,
        event: createEvent({
          author: 'agent',
          actions: {
            stateDelta: {'user:profile': {name: 'Alice'}, session_key: 1},
          },
        }),
      });

      const state = await service.getUserState({
        appName: 'app',
        userId: 'alice',
      });

      expect(state).toEqual({profile: {name: 'Alice'}});
    });
  });

  describe('getSession config validation', () => {
    it('rejects a negative numRecentEvents', async () => {
      await expect(
        service.getSession({
          appName: 'app',
          userId: 'alice',
          sessionId: 'sid',
          config: {numRecentEvents: -1},
        }),
      ).rejects.toThrow(InputValidationError);
    });
  });

  describe('close', () => {
    it('releases the connections, and does nothing on a second call', async () => {
      await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-before-close',
      });

      await service.close();
      await service.close();

      // Every connection to a SQLite in-memory database opens a separate,
      // empty one, so the session is gone exactly when the pool really shut
      // down and the service reconnected.
      const gone = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-before-close',
      });
      expect(gone).toBeUndefined();
    });
  });

  describe('adk-python parity', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('generates an id when the caller supplies whitespace only', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: '   ',
      });

      expect(session.id.trim()).toBe(session.id);
      expect(session.id).not.toBe('');
    });

    it('keeps a caller id that only has surrounding whitespace', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: '  padded  ',
      });

      expect(session.id).toBe('padded');
    });

    it('persists a BigInt state value as its digits, warning once', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-bigint',
        state: {retries: 3n},
      });

      expect(session.state['retries']).toBe('3');
      expect(warn).toHaveBeenCalledTimes(1);

      const loaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-bigint',
      });
      expect(loaded?.state['retries']).toBe('3');
    });

    it('persists a state delta value JSON cannot represent', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-delta-coerce',
      });

      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({stateDelta: {onDone: () => {}}}),
        }),
      });

      const loaded = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-delta-coerce',
      });
      expect(loaded?.state['onDone']).toBe('[Function: onDone]');
    });
  });
});

describe('DatabaseSessionService.close', () => {
  const newService = () =>
    new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });

  it('releases the connection the service opened', async () => {
    const service = newService();
    await service.init();
    const orm = (service as unknown as {orm: MikroORM}).orm;

    await service.close();

    await expect(orm.isConnected()).resolves.toBe(false);
  });

  it('does nothing on a service that was never used', async () => {
    await expect(newService().close()).resolves.toBeUndefined();
  });

  it('can be called twice', async () => {
    const service = newService();
    await service.init();

    await service.close();

    await expect(service.close()).resolves.toBeUndefined();
  });

  it('reconnects when the service is used again', async () => {
    const service = newService();
    await service.init();
    await service.close();

    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
    });

    expect(session.id).toBeDefined();
    await service.close();
  });
});

describe('DatabaseSessionService construction', () => {
  const EXACTLY_ONE_SOURCE =
    'Exactly one of a database URL, MikroORM options, or a MikroORM instance' +
    ' must be provided.';

  function openOrm(dbName = ':memory:'): Promise<MikroORM> {
    return MikroORM.init({
      dbName,
      driver: SqliteDriver,
      entities: ENTITIES,
      allowGlobalContext: true,
    });
  }

  it('rejects an absent source', () => {
    // The cast reaches the runtime path a plain JavaScript caller takes; the
    // TypeScript signature already forbids it.
    expect(
      () => new DatabaseSessionService(undefined as unknown as string),
    ).toThrow(EXACTLY_ONE_SOURCE);
    expect(() => new DatabaseSessionService('')).toThrow(EXACTLY_ONE_SOURCE);
  });

  it('rejects a bad URL from the constructor, before init runs', () => {
    expect(
      () =>
        new DatabaseSessionService('postgresql+asyncpg://user:pw@host:5432/db'),
    ).toThrow("names the 'asyncpg' driver in its scheme");
    expect(() => new DatabaseSessionService('oracle://host/db')).toThrow(
      'Unsupported database URI',
    );
  });

  it('serves a MikroORM instance the caller built and leaves it open', async () => {
    const orm = await openOrm();
    const service = new DatabaseSessionService(orm);

    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    const stored = await service.getSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(stored?.id).toBe('s1');

    await service.close();

    // The caller still owns the instance, so it still answers.
    expect(await orm.em.fork().count(StorageSession, {})).toBe(1);
    const afterClose = await service.listSessions({appName: 'app'});
    expect(afterClose.sessions.map((s) => s.id)).toEqual(['s1']);

    await orm.close();
  });

  it('disposes an ORM it opened itself', async () => {
    const service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    await service.close();

    // A fresh in-memory database is empty, so the session is only missing if
    // the previous connection was really disposed.
    const afterClose = await service.listSessions({appName: 'app'});
    expect(afterClose.sessions).toEqual([]);
    await service.close();
  });

  it('does nothing when closed before init', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:');

    await expect(service.close()).resolves.toBeUndefined();
  });

  it('rejects options combined with a MikroORM instance', async () => {
    const orm = await openOrm();

    expect(() => new DatabaseSessionService(orm, {dbName: 'other.db'})).toThrow(
      'Options cannot be applied to a MikroORM instance the caller already' +
        ' built.',
    );

    await orm.close();
  });

  it('rejects an options object with no driver', () => {
    expect(() => new DatabaseSessionService({dbName: ':memory:'})).toThrow(
      'Driver is required when passing options object.',
    );
  });

  it('applies overrides on top of the options a URL implies', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:', {
      allowGlobalContext: true,
      pool: {min: 1, max: 3},
    });

    const created = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    expect(created.id).toBe('s1');
    await service.close();
  });
});

describe('DatabaseSessionService on a legacy v0 database', () => {
  const appName = 'legacy-app';
  const userId = 'u1';
  const sessionId = 's1';

  let directory: string;
  let databasePath: string;
  let service: DatabaseSessionService;
  let warn: MockInstance<typeof logger.warn>;

  beforeEach(async () => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    directory = await mkdtemp(join(tmpdir(), 'adk-legacy-sessions-'));
    databasePath = join(directory, 'legacy.db');

    const legacyOrm = await MikroORM.init({
      dbName: databasePath,
      driver: SqliteDriver,
      entities: ENTITIES_V0,
      allowGlobalContext: true,
    });
    await legacyOrm.schema.createSchema();

    const em = legacyOrm.em.fork();
    em.create(StorageSession, {
      id: sessionId,
      appName,
      userId,
      state: {seeded: true},
      createTime: new Date(1000),
      updateTime: new Date(2000),
    });
    em.create(StorageEventV0, {
      id: 'e1',
      appName,
      userId,
      sessionId,
      invocationId: 'inv-1',
      author: 'user',
      timestamp: new Date(1500),
      content: {role: 'user', parts: [{text: 'hello'}]},
      actions: Buffer.from('\x80\x04\x95pickled', 'binary'),
      longRunningToolIdsJson: JSON.stringify(['tool-1']),
    });
    await em.flush();
    await legacyOrm.close();

    service = new DatabaseSessionService(`sqlite://${databasePath}`);
  });

  afterEach(async () => {
    await service.close();
    await rm(directory, {recursive: true, force: true});
    warn.mockRestore();
  });

  it('reads a session and its event, with empty actions', async () => {
    const session = await service.getSession({appName, userId, sessionId});

    expect(session?.state['seeded']).toBe(true);
    expect(session?.events.map((e) => e.id)).toEqual(['e1']);
    expect(session?.events[0].content).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
    expect(session?.events[0].longRunningToolIds).toEqual(['tool-1']);
    expect(session?.events[0].actions).toEqual({
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    });
  });

  it('lists the sessions it holds', async () => {
    const response = await service.listSessions({appName, userId});

    expect(response.sessions.map((s) => s.id)).toEqual([sessionId]);
  });

  it('applies afterTimestamp to a legacy event', async () => {
    const included = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {afterTimestamp: 1500},
    });
    const excluded = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {afterTimestamp: 1501},
    });

    expect(included?.events.map((e) => e.id)).toEqual(['e1']);
    expect(excluded?.events).toEqual([]);
  });

  it('deletes a session and its legacy events', async () => {
    await service.deleteSession({appName, userId, sessionId});

    const gone = await service.getSession({appName, userId, sessionId});
    expect(gone).toBeUndefined();

    const remaining = await service.listSessions({appName, userId});
    expect(remaining.sessions).toEqual([]);
  });

  it("warns that it could not decode one event's actions", async () => {
    await service.getSession({appName, userId, sessionId});

    const actionWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('Could not decode the pickled actions'),
    );
    expect(actionWarnings).toHaveLength(1);
  });

  it('creates a session', async () => {
    const created = await service.createSession({
      appName,
      userId,
      sessionId: 's2',
    });

    expect(created.id).toBe('s2');
    await expect(
      service.getSession({appName, userId, sessionId: 's2'}),
    ).resolves.toMatchObject({id: 's2'});
  });

  it('appends an event to a session it created', async () => {
    // The seeded fixture writes no `app_states` row, and `appendEvent` needs
    // the one `createSession` writes on either layout.
    const session = await service.createSession({appName, userId});

    const appended = await service.appendEvent({
      session,
      event: createEvent({timestamp: 9000, author: 'user'}),
    });

    const reloaded = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(reloaded?.events.map((e) => e.id)).toEqual([appended.id]);
  });

  it('leaves the database untouched', async () => {
    await service.getSession({appName, userId, sessionId});
    await service.close();

    const inspector = await MikroORM.init({
      dbName: databasePath,
      driver: SqliteDriver,
      entities: ENTITIES_V0,
      allowGlobalContext: true,
    });
    const connection = inspector.em.getConnection();
    const tables: Array<{name: string}> = await connection.execute(
      "select name from sqlite_master where type = 'table'",
    );
    const columns: Array<{name: string}> = await connection.execute(
      "pragma table_info('events')",
    );
    await inspector.close();

    expect(tables.map((t) => t.name)).not.toContain('adk_internal_metadata');
    expect(columns.map((c) => c.name)).not.toContain('event_data');
    expect(columns.map((c) => c.name)).toContain('actions');
  });

  it('refuses a caller-supplied MikroORM instance', async () => {
    const orm = await MikroORM.init({
      dbName: databasePath,
      driver: SqliteDriver,
      entities: ENTITIES,
      allowGlobalContext: true,
    });
    const callerOwned = new DatabaseSessionService(orm);

    await expect(
      callerOwned.getSession({appName, userId, sessionId}),
    ).rejects.toThrow('connection it opened itself');

    await orm.close();
  });
});

describe('isDatabaseConnectionString', () => {
  it('should identify valid URI connection strings', () => {
    expect(
      isDatabaseConnectionString('postgres://user:pass@localhost:5432/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('postgresql://user:pass@localhost:5432/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('mysql://user:pass@localhost:3306/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('mariadb://user:pass@localhost:3306/db'),
    ).toBe(true);
    expect(isDatabaseConnectionString('sqlite://:memory:')).toBe(true);
    expect(isDatabaseConnectionString('sqlite:///path/to/db.sqlite')).toBe(
      true,
    );
    expect(
      isDatabaseConnectionString('mssql://user:pass@localhost:1433/db'),
    ).toBe(true);
  });

  it('claims a driver-suffixed URI so the service explains the suffix', () => {
    expect(
      isDatabaseConnectionString('postgresql+asyncpg://user:pw@host:5432/db'),
    ).toBe(true);
    expect(isDatabaseConnectionString('oracle://host/db')).toBe(false);
  });

  it('should reject invalid strings', () => {
    expect(isDatabaseConnectionString('')).toBe(false);
    expect(isDatabaseConnectionString(undefined)).toBe(false);
    expect(isDatabaseConnectionString('http://google.com')).toBe(false);
    expect(isDatabaseConnectionString('https://google.com')).toBe(false);
    expect(isDatabaseConnectionString('/path/to/file')).toBe(false);
    expect(isDatabaseConnectionString('C:\\path\\to\\file')).toBe(false);
    expect(isDatabaseConnectionString('just some text')).toBe(false);
    expect(isDatabaseConnectionString('random=text;with=semicolons')).toBe(
      false,
    ); // Has = and ; but no common keys
    expect(isDatabaseConnectionString('Server=myServer')).toBe(false); // Missing semicolon implies not a full connection string or just a weird config
  });
});

describe('DatabaseSessionService.getUserState', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    service = new DatabaseSessionService('sqlite://:memory:');
    await service.init();
  });

  afterEach(async () => {
    await service.close();
  });

  it('returns an empty object when the user has no stored state', async () => {
    await expect(
      service.getUserState({appName: 'app', userId: 'u1'}),
    ).resolves.toEqual({});
  });

  it('returns raw keys and excludes app and session scopes', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.appendEvent({
      session,
      event: createEvent({
        actions: createEventActions({
          stateDelta: {
            [State.USER_PREFIX + 'profile']: {name: 'Alice'},
            [State.APP_PREFIX + 'theme']: 'dark',
            'turnCount': 3,
          },
        }),
      }),
    });

    await expect(
      service.getUserState({appName: 'app', userId: 'u1'}),
    ).resolves.toEqual({profile: {name: 'Alice'}});
  });

  it('is readable without a session id, from the initial state', async () => {
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
      state: {[State.USER_PREFIX + 'lang']: 'fr'},
    });

    await expect(
      service.getUserState({appName: 'app', userId: 'u1'}),
    ).resolves.toEqual({lang: 'fr'});
  });

  it('isolates state across users and across apps', async () => {
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
      state: {[State.USER_PREFIX + 'lang']: 'fr'},
    });
    await service.createSession({
      appName: 'app',
      userId: 'u2',
      sessionId: 's2',
    });
    await service.createSession({
      appName: 'other',
      userId: 'u1',
      sessionId: 's3',
    });

    await expect(
      service.getUserState({appName: 'app', userId: 'u2'}),
    ).resolves.toEqual({});
    await expect(
      service.getUserState({appName: 'other', userId: 'u1'}),
    ).resolves.toEqual({});
  });

  it('reflects the latest write after two appends', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    for (const value of ['A', 'B']) {
      await service.appendEvent({
        session,
        event: createEvent({
          actions: createEventActions({
            stateDelta: {[State.USER_PREFIX + 'pref']: value},
          }),
        }),
      });
    }

    await expect(
      service.getUserState({appName: 'app', userId: 'u1'}),
    ).resolves.toEqual({pref: 'B'});
  });

  it('returns a copy that a caller cannot write back through', async () => {
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
      state: {[State.USER_PREFIX + 'lang']: 'fr'},
    });

    const state = await service.getUserState({appName: 'app', userId: 'u1'});
    state['lang'] = 'de';

    await expect(
      service.getUserState({appName: 'app', userId: 'u1'}),
    ).resolves.toEqual({lang: 'fr'});
  });
});

describe('DatabaseSessionService stale session detection', () => {
  let service: DatabaseSessionService;
  const appName = 'app';
  const userId = 'u1';
  const sessionId = 's1';

  beforeEach(async () => {
    service = new DatabaseSessionService('sqlite://:memory:');
    await service.createSession({appName, userId, sessionId});
  });

  afterEach(async () => {
    await service.close();
  });

  async function load(): Promise<Session> {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail(`session ${sessionId} was not stored`);
    }
    return session;
  }

  it('stamps a marker on create, get and list', async () => {
    const listed = await service.listSessions({appName, userId});

    expect(await load()).toHaveProperty(
      'storageUpdateMarker',
      expect.any(String),
    );
    expect(listed.sessions[0].storageUpdateMarker).toEqual(expect.any(String));
    expect(listed.sessions[0].storageUpdateMarker).not.toBe('');
  });

  it('rejects the second of two writers holding the same revision', async () => {
    const first = await load();
    const second = await load();

    await service.appendEvent({session: first, event: createEvent()});
    await expect(
      service.appendEvent({session: second, event: createEvent()}),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });

  it('reports a stale write with the reload instruction', async () => {
    const first = await load();
    const second = await load();
    await service.appendEvent({session: first, event: createEvent()});

    await expect(
      service.appendEvent({session: second, event: createEvent()}),
    ).rejects.toThrow(/modified in storage/);
  });

  it('leaves storage untouched when it rejects a stale write', async () => {
    const first = await load();
    const second = await load();
    const winner = createEvent({
      actions: createEventActions({stateDelta: {owner: 'first'}}),
    });
    await service.appendEvent({session: first, event: winner});

    const loser = createEvent({
      actions: createEventActions({stateDelta: {owner: 'second'}}),
    });
    await expect(
      service.appendEvent({session: second, event: loser}),
    ).rejects.toBeInstanceOf(StaleSessionError);

    const reloaded = await load();
    expect(reloaded.events.map((e) => e.id)).toEqual([winner.id]);
    expect(reloaded.state['owner']).toBe('first');
  });

  it('rejects exactly one of two concurrent appends, every round', async () => {
    for (let round = 0; round < 8; round++) {
      const [first, second] = [await load(), await load()];
      const results = await Promise.allSettled([
        service.appendEvent({session: first, event: createEvent()}),
        service.appendEvent({session: second, event: createEvent()}),
      ]);

      const rejections = results.filter((r) => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBeInstanceOf(StaleSessionError);
    }
  });

  it('accepts a session whose timestamp drifted but whose marker matches', async () => {
    const session = await load();
    session.lastUpdateTime -= 5;

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).resolves.toBeDefined();
  });

  it('accepts a marker-less session that still holds the newest event', async () => {
    const session = await load();
    await service.appendEvent({session, event: createEvent()});

    session.storageUpdateMarker = undefined;
    session.lastUpdateTime = 1;

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).resolves.toBeDefined();
  });

  it('accepts a marker-less session when storage holds no events either', async () => {
    const session = await load();
    session.storageUpdateMarker = undefined;
    session.lastUpdateTime = 1;

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).resolves.toBeDefined();
  });

  it('rejects a marker-less session that another writer moved past', async () => {
    const behind = await load();
    const ahead = await load();
    await service.appendEvent({session: ahead, event: createEvent()});

    behind.storageUpdateMarker = undefined;
    behind.lastUpdateTime = 1;

    await expect(
      service.appendEvent({session: behind, event: createEvent()}),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });

  it('rejects a marker-less empty session when storage already has events', async () => {
    const session = await load();
    await service.appendEvent({session, event: createEvent()});

    const handMade = createSession({
      id: sessionId,
      appName,
      userId,
      lastUpdateTime: 1,
    });

    await expect(
      service.appendEvent({session: handMade, event: createEvent()}),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });

  it('carries the marker through a get, append and get round trip', async () => {
    const loaded = await load();
    const before = loaded.storageUpdateMarker;
    expect(before).toEqual(expect.any(String));

    await service.appendEvent({session: loaded, event: createEvent()});
    const afterAppend = loaded.storageUpdateMarker;
    expect(afterAppend).toEqual(expect.any(String));
    expect(afterAppend).not.toBe(before);

    const reloaded = await load();
    expect(reloaded.storageUpdateMarker).toBe(afterAppend);
  });

  it('produces a different marker for appends one millisecond apart', async () => {
    const session = await load();
    const base = Date.now();

    await service.appendEvent({
      session,
      event: createEvent({timestamp: base}),
    });
    const first = session.storageUpdateMarker;

    await service.appendEvent({
      session,
      event: createEvent({timestamp: base + 1}),
    });

    expect(first).toEqual(expect.any(String));
    expect(session.storageUpdateMarker).not.toBe(first);
  });
});

describe('DatabaseSessionService with a whole-second timestamp column', () => {
  let orm: MikroORM;
  let service: DatabaseSessionService;
  const appName = 'app';
  const userId = 'u1';
  const sessionId = 's1';

  beforeEach(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    service = new DatabaseSessionService(orm);
    await service.init();

    // MySQL and MariaDB round a `DATETIME` column with no fractional digits to
    // the whole second, which a database created before this schema declared
    // millisecond precision still does. SQLite keeps the column as an integer
    // of milliseconds, so these triggers reproduce that rounding here.
    const key =
      'id = new.id and app_name = new.app_name and user_id = new.user_id';
    const connection = orm.em.getConnection();
    await connection.execute(
      'create trigger round_insert after insert on sessions begin ' +
        'update sessions set ' +
        'create_time = cast(new.create_time / 1000 as integer) * 1000, ' +
        'update_time = cast(new.update_time / 1000 as integer) * 1000 ' +
        `where ${key}; end`,
    );
    await connection.execute(
      'create trigger round_update after update of update_time on sessions ' +
        'when new.update_time % 1000 <> 0 begin ' +
        'update sessions set ' +
        'update_time = cast(new.update_time / 1000 as integer) * 1000 ' +
        `where ${key}; end`,
    );
  });

  afterEach(async () => {
    await service.close();
    await orm.close();
  });

  it('accepts repeated appends through one held session', async () => {
    const session = await service.createSession({appName, userId, sessionId});
    const base = 1_700_000_000_000;

    for (const offset of [414, 1_900, 2_001]) {
      await expect(
        service.appendEvent({
          session,
          event: createEvent({timestamp: base + offset}),
        }),
      ).resolves.toBeDefined();
    }

    const reloaded = await service.getSession({appName, userId, sessionId});
    expect(reloaded?.events).toHaveLength(3);
    expect(reloaded?.storageUpdateMarker).toBe(session.storageUpdateMarker);
  });

  it('still rejects a writer that storage has moved past', async () => {
    await service.createSession({appName, userId, sessionId});
    const first = await service.getSession({appName, userId, sessionId});
    const second = await service.getSession({appName, userId, sessionId});
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await service.appendEvent({
      session: first!,
      event: createEvent({timestamp: 1_700_000_005_000}),
    });

    await expect(
      service.appendEvent({
        session: second!,
        event: createEvent({timestamp: 1_700_000_009_000}),
      }),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });
});

describe('DatabaseSessionService typed errors', () => {
  let orm: MikroORM;
  let service: DatabaseSessionService;

  beforeEach(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    service = new DatabaseSessionService(orm);
    await service.init();
  });

  afterEach(async () => {
    await service.close();
    await orm.close();
  });

  it('rejects a duplicate session id with AlreadyExistsError', async () => {
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    await expect(
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it('rejects one of two concurrent creates of the same id', async () => {
    const results = await Promise.allSettled([
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ]);

    const rejections = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBeInstanceOf(AlreadyExistsError);
  });

  it('rejects an append to a deleted session with SessionNotFoundError', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.deleteSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('rejects an append when the app state row was removed out of band', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    await orm.em.getConnection().execute('delete from app_states');

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).rejects.toThrow("App state missing for app_name='app'");
  });

  it('rejects an append when the user state row was removed out of band', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    await orm.em.getConnection().execute('delete from user_states');

    await expect(
      service.appendEvent({session, event: createEvent()}),
    ).rejects.toThrow("User state missing for app_name='app', user_id='u1'");
  });

  it('re-raises a write failure that is not a duplicate session', async () => {
    await orm.em
      .getConnection()
      .execute(
        'create trigger block_insert before insert on app_states begin ' +
          "select raise(abort, 'blocked by the test'); end",
      );

    await expect(
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow(/blocked by the test/);
  });
});

describe('DatabaseSessionService appendEvent shapes', () => {
  let service: DatabaseSessionService;
  const appName = 'app';
  const userId = 'u1';
  const sessionId = 's1';

  beforeEach(async () => {
    service = new DatabaseSessionService('sqlite://:memory:');
    await service.createSession({appName, userId, sessionId});
  });

  afterEach(async () => {
    await service.close();
  });

  async function load(): Promise<Session> {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail(`session ${sessionId} was not stored`);
    }
    return session;
  }

  it('stores nothing for a partial event', async () => {
    const session = await load();

    const event = createEvent({partial: true});
    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    const reloaded = await load();
    expect(reloaded.events).toHaveLength(0);
    expect(session.events).toHaveLength(0);
  });

  it('accepts an event whose actions carry no state delta', async () => {
    const session = await load();

    await service.appendEvent({
      session,
      event: createEvent({actions: {stateDelta: undefined}}),
    });

    const reloaded = await load();
    expect(reloaded.events).toHaveLength(1);
  });

  it('overwrites a stored event that is appended again', async () => {
    const session = await load();
    const event = createEvent({
      timestamp: 1_700_000_000_000,
      actions: createEventActions({stateDelta: {round: 1}}),
    });
    await service.appendEvent({session, event});

    event.timestamp = 1_700_000_000_500;
    event.actions = createEventActions({stateDelta: {round: 2}});
    await service.appendEvent({session, event});

    const reloaded = await load();
    expect(reloaded.events).toHaveLength(1);
    expect(reloaded.events[0].actions?.stateDelta?.['round']).toBe(2);
    expect(reloaded.state['round']).toBe(2);
  });

  it('generates a session id when the caller supplies none', async () => {
    const created = await service.createSession({appName, userId});

    expect(created.id).toEqual(expect.any(String));
    expect(created.id).not.toBe('');
    await expect(
      service.getSession({appName, userId, sessionId: created.id}),
    ).resolves.toBeDefined();
  });
});

describe('DatabaseSessionService lifecycle', () => {
  it('drops the connection it opened, and close is idempotent', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:');
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    await service.close();
    await service.close();

    // A fresh sqlite in-memory database is empty, so a session that survives
    // would mean the old connection was still in use.
    await expect(
      service.getSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeUndefined();
    await service.close();
  });

  it('does nothing when closed before init', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:');
    await expect(service.close()).resolves.toBeUndefined();
  });

  it('leaves a caller-supplied ORM open', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    const service = new DatabaseSessionService(orm);
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });

    await service.close();

    await expect(orm.isConnected()).resolves.toBe(true);
    await expect(
      service.getSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeDefined();
    await orm.close();
  });

  it('stays usable when init is called twice and concurrently', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:');
    await Promise.all([service.init(), service.init()]);
    await service.init();

    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    });
    await expect(
      service.getSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeDefined();
    await service.close();
  });

  it('rejects a legacy v0 database instead of upgrading it', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    await orm.em
      .getConnection()
      .execute('create table events (id text primary key, actions blob)');
    const service = new DatabaseSessionService(orm);

    await expect(service.init()).rejects.toThrow('legacy v0 session schema');
    await orm.close();
  });

  it('rejects a metadata table with no schema version', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    await orm.em
      .getConnection()
      .execute(
        'create table adk_internal_metadata ("key" text primary key, value text)',
      );
    const service = new DatabaseSessionService(orm);

    await expect(service.init()).rejects.toThrow('might be malformed');
    await orm.close();
  });
});

describe('DatabaseSessionService connection validation', () => {
  it('rejects an unusable connection string from the constructor', () => {
    expect(() => new DatabaseSessionService('definitely not a url')).toThrow(
      'Invalid database URL format or argument',
    );
  });

  it('names the driver a SQLAlchemy-style scheme carries', () => {
    expect(
      () => new DatabaseSessionService('postgresql+asyncpg://user:pw@host/db'),
    ).toThrow(/'asyncpg' driver/);
    expect(
      () => new DatabaseSessionService('postgresql+asyncpg://user:pw@host/db'),
    ).toThrow(/'postgresql:\/\/' URL instead/);
  });

  it('keeps the password out of a driver-suffix rejection', () => {
    const password = 'sup3rs3cr3tpassphrase';
    try {
      new DatabaseSessionService(`mysql+aiomysql://user:${password}@host/db`);
      expect.fail('the constructor accepted a driver-suffixed URI');
    } catch (error: unknown) {
      expect(String(error)).not.toContain(password);
      expect(String(error)).toContain('aiomysql');
    }
  });

  it('routes a driver-suffixed URI to this service', () => {
    expect(isDatabaseConnectionString('postgresql+asyncpg://host/db')).toBe(
      true,
    );
    expect(isDatabaseConnectionString('sqlite+aiosqlite:///sessions.db')).toBe(
      true,
    );
  });

  it('keeps the password out of the rejection message', () => {
    const password = 'sup3rs3cr3tpassphrase';
    expect(
      () => new DatabaseSessionService(`oracle://user:${password}@host/db`),
    ).toThrow(/Unsupported database URI/);
    try {
      new DatabaseSessionService(`oracle://user:${password}@host/db`);
      expect.fail('the constructor accepted an unsupported URI');
    } catch (error: unknown) {
      expect(String(error)).not.toContain(password);
    }
  });

  it('still requires a driver in the options form', () => {
    expect(() => new DatabaseSessionService({dbName: ':memory:'})).toThrow(
      'Driver is required',
    );
  });

  it('applies caller options over the ones derived from the URI', async () => {
    const service = new DatabaseSessionService('sqlite://:memory:', {
      pool: {min: 1, max: 1},
      debug: false,
    });
    await service.init();

    await expect(
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeDefined();
    await service.close();
  });
});

describe('DatabaseSessionService event ordering', () => {
  let service: DatabaseSessionService;
  const appName = 'app';
  const userId = 'u1';
  const sessionId = 's1';

  beforeEach(async () => {
    service = new DatabaseSessionService('sqlite://:memory:');
    await service.createSession({appName, userId, sessionId});
  });

  afterEach(async () => {
    await service.close();
  });

  async function appendTiedEvents(timestamp: number): Promise<string[]> {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail(`session ${sessionId} was not stored`);
    }
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const event = createEvent({timestamp});
      await service.appendEvent({session, event});
      ids.push(event.id);
    }
    return ids.sort();
  }

  it('returns events with tied timestamps in a stable id order', async () => {
    const sortedIds = await appendTiedEvents(1_700_000_000_000);

    for (let read = 0; read < 3; read++) {
      const loaded = await service.getSession({appName, userId, sessionId});
      expect(loaded?.events.map((e) => e.id)).toEqual(sortedIds);
    }
  });

  it('truncates a tie deterministically for numRecentEvents', async () => {
    const sortedIds = await appendTiedEvents(1_700_000_000_000);

    const loaded = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {numRecentEvents: 2},
    });

    expect(loaded?.events.map((e) => e.id)).toEqual(sortedIds.slice(-2));
  });
});

describe('DatabaseSessionService temp state', () => {
  let service: DatabaseSessionService;
  const appName = 'app';
  const userId = 'u1';
  const sessionId = 's1';

  beforeEach(async () => {
    service = new DatabaseSessionService('sqlite://:memory:');
    await service.createSession({appName, userId, sessionId});
  });

  afterEach(async () => {
    await service.close();
  });

  it('keeps a temp key readable on the in-memory session', async () => {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail(`session ${sessionId} was not stored`);
    }

    await service.appendEvent({
      session,
      event: createEvent({
        actions: createEventActions({
          stateDelta: {
            [State.TEMP_PREFIX + 'draft']: 'in progress',
            'saved': 'yes',
          },
        }),
      }),
    });

    expect(session.state[State.TEMP_PREFIX + 'draft']).toBe('in progress');
    expect(session.state['saved']).toBe('yes');
  });

  it('does not persist a temp key into the stored session state', async () => {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail(`session ${sessionId} was not stored`);
    }

    await service.appendEvent({
      session,
      event: createEvent({
        actions: createEventActions({
          stateDelta: {[State.TEMP_PREFIX + 'draft']: 'in progress'},
        }),
      }),
    });

    const reloaded = await service.getSession({appName, userId, sessionId});
    expect(reloaded?.state[State.TEMP_PREFIX + 'draft']).toBeUndefined();
    expect(
      reloaded?.events[0].actions?.stateDelta?.[State.TEMP_PREFIX + 'draft'],
    ).toBeUndefined();
  });
});

describe('DatabaseSessionService concurrent state rows', () => {
  let orm: MikroORM;
  let service: DatabaseSessionService;

  beforeEach(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
      allowGlobalContext: true,
    });
    service = new DatabaseSessionService(orm);
    await service.init();
  });

  afterEach(async () => {
    await orm.close();
  });

  it('creates one app state row for two concurrent sessions', async () => {
    const created = await Promise.all([
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
      service.createSession({appName: 'app', userId: 'u2', sessionId: 's2'}),
    ]);

    expect(created.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(await orm.em.fork().count(StorageAppState, {appName: 'app'})).toBe(
      1,
    );
  });

  it('creates one user state row for two concurrent sessions', async () => {
    const created = await Promise.all([
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's2'}),
    ]);

    expect(created.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(
      await orm.em
        .fork()
        .count(StorageUserState, {appName: 'app', userId: 'u1'}),
    ).toBe(1);
  });

  it('surfaces a state row failure that is not a lost race', async () => {
    await orm.em.getConnection().execute('drop table app_states');

    await expect(
      service.createSession({appName: 'app', userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow(/app_states/);
  });
});

describe('DatabaseSessionService v0 schema', () => {
  const appName = 'legacy-app';
  const userId = 'legacy-user';
  const sessionId = 'legacy-session';
  let directory: string;
  let databaseFile: string;
  let service: DatabaseSessionService;

  /** Writes the tables and rows adk-python 1.19 to 1.21 left behind. */
  async function writeLegacyDatabase(file: string): Promise<void> {
    const orm = await MikroORM.init({
      dbName: file,
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    const connection = orm.em.getConnection();
    await connection.execute(
      'create table sessions (app_name text, user_id text, id text, ' +
        'state text, create_time datetime, update_time datetime, ' +
        'primary key (app_name, user_id, id))',
    );
    await connection.execute(
      'create table app_states (app_name text primary key, state text, ' +
        'update_time datetime)',
    );
    await connection.execute(
      'create table user_states (app_name text, user_id text, state text, ' +
        'update_time datetime, primary key (app_name, user_id))',
    );
    await connection.execute(
      'create table events (id text, app_name text, user_id text, ' +
        'session_id text, invocation_id text, author text, actions blob, ' +
        'long_running_tool_ids_json text, branch text, timestamp datetime, ' +
        'content text, grounding_metadata text, custom_metadata text, ' +
        'usage_metadata text, citation_metadata text, partial boolean, ' +
        'turn_complete boolean, error_code text, error_message text, ' +
        'interrupted boolean, input_transcription text, ' +
        'output_transcription text, primary key (app_name, user_id, ' +
        'session_id, id))',
    );
    await connection.execute(
      "insert into sessions values ('legacy-app', 'legacy-user', " +
        '\'legacy-session\', \'{"topic":"pickles"}\', 1000, 2000)',
    );
    await connection.execute(
      'insert into app_states values (\'legacy-app\', \'{"tier":"free"}\', 1000)',
    );
    await connection.execute(
      "insert into user_states values ('legacy-app', 'legacy-user', " +
        '\'{"locale":"en"}\', 1000)',
    );
    await connection.execute(
      'insert into events (id, app_name, user_id, session_id, ' +
        'invocation_id, author, actions, long_running_tool_ids_json, ' +
        'branch, timestamp, content, partial, error_message) values ' +
        "('e1', 'legacy-app', 'legacy-user', 'legacy-session', 'inv-1', " +
        "'user', x'80049503', '[\"tool-a\"]', 'root.child', 1000, " +
        '\'{"parts":[{"text":"hi"}],"role":"user"}\', 0, null)',
    );
    await connection.execute(
      'insert into events (id, app_name, user_id, session_id, ' +
        'invocation_id, author, actions, branch, timestamp, content, ' +
        'partial, error_message) values ' +
        "('e2', 'legacy-app', 'legacy-user', 'legacy-session', 'inv-1', " +
        "'assistant', x'80049504', null, 2000, " +
        '\'{"parts":[{"text":"hello"}],"role":"model"}\', 1, ' +
        "'model stalled')",
    );
    await orm.close();
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'adk-legacy-db-'));
    databaseFile = join(directory, 'legacy.db');
    await writeLegacyDatabase(databaseFile);
    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
  });

  afterEach(async () => {
    await service.close();
    await rm(directory, {recursive: true, force: true});
  });

  /** Reports whether the legacy database has gained a v1 artefact. */
  async function inspectLegacyTables(): Promise<{
    hasMetadataTable: boolean;
    hasEventDataColumn: boolean;
  }> {
    const orm = await MikroORM.init({
      dbName: databaseFile,
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    const connection = orm.em.getConnection();
    const tables: Array<{name: string}> = await connection.execute(
      "select name from sqlite_master where type = 'table'",
      [],
      'all',
    );
    const columns: Array<{name: string}> = await connection.execute(
      'pragma table_info(events)',
      [],
      'all',
    );
    await orm.close();
    return {
      hasMetadataTable: tables.some(
        (table) => table.name === METADATA_TABLE_NAME,
      ),
      hasEventDataColumn: columns.some(
        (column) => column.name === 'event_data',
      ),
    };
  }

  it('opens the database without altering it', async () => {
    await service.init();

    const inspected = await inspectLegacyTables();
    expect(inspected.hasMetadataTable).toBe(false);
    expect(inspected.hasEventDataColumn).toBe(false);
  });

  it('reads the stored events oldest first', async () => {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail('the legacy session was not read');
    }

    expect(session.events.map((event) => event.id)).toEqual(['e1', 'e2']);
    const [first, second] = session.events;
    expect(first.author).toBe('user');
    expect(first.branch).toBe('root.child');
    expect(first.content?.parts?.[0].text).toBe('hi');
    expect(first.longRunningToolIds).toEqual(['tool-a']);
    expect(first.actions.stateDelta).toEqual({});
    expect(second.partial).toBe(true);
    expect(second.errorMessage).toBe('model stalled');
    expect(second.timestamp).toBe(2000);
  });

  it('merges the app, user and session state', async () => {
    const session = await service.getSession({appName, userId, sessionId});

    expect(session?.state).toEqual({
      'topic': 'pickles',
      'app:tier': 'free',
      'user:locale': 'en',
    });
  });

  it('lists the legacy session', async () => {
    const listed = await service.listSessions({appName, userId});

    expect(listed.sessions.map((session) => session.id)).toEqual([sessionId]);
    expect(listed.sessions[0].state['topic']).toBe('pickles');
  });

  it('deletes the session and its events', async () => {
    await service.deleteSession({appName, userId, sessionId});

    await expect(
      service.getSession({appName, userId, sessionId}),
    ).resolves.toBeUndefined();
    const remaining = await countLegacyEvents(databaseFile);
    expect(remaining).toBe(0);
  });

  it('creates a session', async () => {
    const created = await service.createSession({
      appName,
      userId,
      sessionId: 'new-session',
    });

    expect(created.id).toBe('new-session');
    await expect(
      service.getSession({appName, userId, sessionId: 'new-session'}),
    ).resolves.toMatchObject({id: 'new-session'});
  });

  it('appends an event', async () => {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail('the legacy session was not read');
    }

    const before = await countLegacyEvents(databaseFile);

    const appended = await service.appendEvent({
      session,
      event: createEvent({timestamp: 3000, author: 'user'}),
    });

    expect(await countLegacyEvents(databaseFile)).toBe(before + 1);
    const reloaded = await service.getSession({appName, userId, sessionId});
    expect(reloaded?.events.map((e) => e.id)).toContain(appended.id);
  });

  it('warns once that the database uses the deprecated v0 schema', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await service.getSession({appName, userId, sessionId});
    await service.getSession({appName, userId, sessionId});

    const schemaWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('legacy v0 session schema'),
    );
    expect(schemaWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('cannot open a legacy database through a caller-supplied ORM', async () => {
    const orm = await MikroORM.init({
      dbName: databaseFile,
      driver: SqliteDriver,
      entities: ENTITIES,
      pool: {min: 1, max: 1},
    });
    const supplied = new DatabaseSessionService(orm);

    await expect(supplied.init()).rejects.toThrow('legacy v0 session schema');
    await orm.close();
  });
});

describe('DatabaseSessionService read and write entity managers', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await service.init();
    await service.createSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'split-session',
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service.close();
  });

  it('reads a session through the read entity manager', async () => {
    await service.getSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'split-session',
    });

    expect(forkForRead).toHaveBeenCalledTimes(1);
    expect(forkForWrite).not.toHaveBeenCalled();
  });

  it('lists sessions through the read entity manager', async () => {
    await service.listSessions({appName: 'split-app'});

    expect(forkForRead).toHaveBeenCalledTimes(1);
    expect(forkForWrite).not.toHaveBeenCalled();
  });

  it('creates a session through the write entity manager', async () => {
    await service.createSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'written-session',
    });

    expect(forkForWrite).toHaveBeenCalledTimes(1);
    expect(forkForRead).not.toHaveBeenCalled();
  });

  it('deletes a session through the write entity manager', async () => {
    await service.deleteSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'split-session',
    });

    expect(forkForWrite).toHaveBeenCalledTimes(1);
    expect(forkForRead).not.toHaveBeenCalled();
  });

  it('appends an event through the write entity manager', async () => {
    const session = await service.getSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'split-session',
    });
    if (!session) {
      expect.fail('the seeded session was expected to exist');
    }
    vi.clearAllMocks();

    await service.appendEvent({
      session,
      event: createEvent({author: 'user', invocationId: 'inv-1'}),
    });

    expect(forkForWrite).toHaveBeenCalledTimes(1);
    expect(forkForRead).not.toHaveBeenCalled();
  });

  it('stays usable after a read throws', async () => {
    const broken = vi.mocked(forkForRead).mockImplementationOnce(() => {
      throw new Error('read entity manager unavailable');
    });

    await expect(
      service.getSession({
        appName: 'split-app',
        userId: 'split-user',
        sessionId: 'split-session',
      }),
    ).rejects.toThrow('read entity manager unavailable');
    expect(broken).toHaveBeenCalledTimes(1);

    const recovered = await service.getSession({
      appName: 'split-app',
      userId: 'split-user',
      sessionId: 'split-session',
    });
    expect(recovered?.id).toBe('split-session');
  });
});

describe('DatabaseSessionService row-level locking', () => {
  /**
   * Appends one event with the backend probe stubbed, and reports the lock
   * modes `appendEvent` asked for when it loaded the session row.
   */
  async function lockModesForBackend(
    backend: string,
  ): Promise<Array<LockMode | undefined>> {
    vi.mocked(getDatabaseBackend).mockReturnValue(backend);
    const service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    const session = await service.createSession({
      appName: 'lock-app',
      userId: 'lock-user',
      sessionId: 'lock-session',
    });

    const findOne = vi.spyOn(EntityManager.prototype, 'findOne');
    try {
      await service.appendEvent({
        session,
        event: createEvent({author: 'user', invocationId: 'inv-lock'}),
      });
      // `mockRestore` also clears the recorded calls, so read them first.
      return findOne.mock.calls
        .filter(([entityName]) => entityName === StorageSession)
        .map(([, , options]) => options?.lockMode);
    } finally {
      findOne.mockRestore();
      await service.close();
    }
  }

  it('takes no row-level lock on sqlite', async () => {
    expect(await lockModesForBackend('sqlite')).toEqual([undefined]);
  });

  it('takes no row-level lock on mssql', async () => {
    expect(await lockModesForBackend('mssql')).toEqual([undefined]);
  });

  it('takes a row-level write lock on postgresql', async () => {
    expect(await lockModesForBackend('postgresql')).toEqual([
      LockMode.PESSIMISTIC_WRITE,
    ]);
  });
});

/** The pooled sqlite connection the test reads its pragma from. */
interface PooledSqliteConnection {
  get(
    sql: string,
    callback: (error: Error | null, row?: {foreign_keys?: number}) => void,
  ): void;
}

interface KnexBackedConnection {
  getKnex(): {
    client: {
      acquireConnection(): Promise<PooledSqliteConnection>;
      releaseConnection(connection: PooledSqliteConnection): void;
    };
  };
}

function isKnexBackedConnection(value: object): value is KnexBackedConnection {
  return 'getKnex' in value && typeof value.getKnex === 'function';
}

function readForeignKeys(connection: PooledSqliteConnection): Promise<number> {
  return new Promise((resolve, reject) => {
    connection.get('pragma foreign_keys', (error, row) => {
      if (error || row?.foreign_keys === undefined) {
        reject(error ?? new Error('the pragma returned no row'));
        return;
      }
      resolve(row.foreign_keys);
    });
  });
}

/**
 * Opens a two-connection pool against `databaseFile` and reports the
 * `foreign_keys` setting each of its connections carries.
 */
async function foreignKeysPerConnection(
  databaseFile: string,
  withPragmaHook: boolean,
): Promise<number[]> {
  const orm = await MikroORM.init(
    await getConnectionOptionsFromUri(`sqlite://${databaseFile}`, {
      pool: {min: 2, max: 2},
      ...(withPragmaHook ? {} : {driverOptions: {}}),
    }),
  );
  const connection = orm.em.getConnection();
  if (!isKnexBackedConnection(connection)) {
    expect.fail('the sqlite connection was expected to expose a knex handle');
  }

  const {client} = connection.getKnex();
  const pooled = [
    await client.acquireConnection(),
    await client.acquireConnection(),
  ];
  try {
    return [await readForeignKeys(pooled[0]), await readForeignKeys(pooled[1])];
  } finally {
    pooled.forEach((one) => client.releaseConnection(one));
    await orm.close();
  }
}

describe('DatabaseSessionService lifecycle on a database file', () => {
  let databaseFile: string;

  beforeEach(() => {
    databaseFile = join(
      mkdtempSync(join(tmpdir(), 'adk-session-db-')),
      'sessions.db',
    );
  });

  afterEach(() => {
    rmSync(dirname(databaseFile), {recursive: true, force: true});
  });

  it('closes before init without throwing', async () => {
    const service = new DatabaseSessionService(`sqlite://${databaseFile}`);

    await expect(service.close()).resolves.toBeUndefined();
  });

  it('closes twice without throwing', async () => {
    const service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.init();

    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.close()).resolves.toBeUndefined();
  });

  it('closes after a failed init without throwing', async () => {
    // A regular file where the database directory should be, so the driver
    // cannot create the database.
    writeFileSync(join(dirname(databaseFile), 'blocked'), '');
    const service = new DatabaseSessionService(
      `sqlite://${join(dirname(databaseFile), 'blocked', 'x.db')}`,
    );
    await expect(service.init()).rejects.toThrow(
      /^Failed to create database engine for URL 'sqlite:/,
    );

    await expect(service.close()).resolves.toBeUndefined();
  });

  it('retries a failed init', async () => {
    writeFileSync(join(dirname(databaseFile), 'blocked2'), '');
    const blockedPath = join(dirname(databaseFile), 'blocked2');
    const service = new DatabaseSessionService(
      `sqlite://${join(blockedPath, 'x.db')}`,
    );
    await expect(service.init()).rejects.toThrow(
      'Failed to create database engine for URL',
    );

    rmSync(blockedPath);
    await expect(service.init()).resolves.toBeUndefined();
    await service.close();
  });

  it('releases the database so another service can reopen it', async () => {
    const service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    const session = await service.createSession({
      appName: 'file-app',
      userId: 'file-user',
      sessionId: 'file-session',
    });
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', invocationId: 'inv-file'}),
    });
    await service.close();

    const reopened = new DatabaseSessionService(`sqlite://${databaseFile}`);
    const restored = await reopened.getSession({
      appName: 'file-app',
      userId: 'file-user',
      sessionId: 'file-session',
    });
    expect(restored?.events.map((event) => event.invocationId)).toEqual([
      'inv-file',
    ]);

    await reopened.deleteSession({
      appName: 'file-app',
      userId: 'file-user',
      sessionId: 'file-session',
    });
    const deleted = await reopened.getSession({
      appName: 'file-app',
      userId: 'file-user',
      sessionId: 'file-session',
    });
    expect(deleted).toBeUndefined();
    await reopened.close();
  });

  it('turns foreign keys on for every sqlite connection the pool opens', async () => {
    // The sqlite driver runs the pragma once while connecting, so only the
    // first pooled connection gets it. The control below pins that, and is
    // what makes the assertion above it meaningful.
    expect(await foreignKeysPerConnection(databaseFile, true)).toEqual([1, 1]);
    expect(await foreignKeysPerConnection(databaseFile, false)).toEqual([1, 0]);
  });

  it('reopens the database when init follows close', async () => {
    const service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.createSession({
      appName: 'reuse-app',
      userId: 'reuse-user',
      sessionId: 'reuse-session',
    });
    await service.close();

    await service.init();
    const restored = await service.getSession({
      appName: 'reuse-app',
      userId: 'reuse-user',
      sessionId: 'reuse-session',
    });
    expect(restored?.id).toBe('reuse-session');
    await service.close();
  });

  it('closes the service at the end of an await using block', async () => {
    const service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    // The spy calls through, so the block exit also releases the database
    // file. A stub would leave it open, which Windows cannot then unlink.
    const close = vi.spyOn(service, 'close');

    {
      await using disposable = service;
      await disposable.init();
      expect(close).not.toHaveBeenCalled();
    }

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('DatabaseSessionService construction diagnostics', () => {
  const password = 'hunter2';

  it('rejects a driver named in the scheme, with the password masked', () => {
    expect(
      () =>
        new DatabaseSessionService(
          `postgresql+asyncpg://user:${password}@db:5432/app`,
        ),
    ).toThrow(
      "Database URL 'postgresql+asyncpg://user:***@db:5432/app' names the " +
        "'asyncpg' driver in its scheme.",
    );
  });

  it('rejects a string that is not a URL', () => {
    expect(() => new DatabaseSessionService('definitely not a url')).toThrow(
      'Invalid database URL format or argument',
    );
  });

  it('rejects overrides combined with an options object', () => {
    expect(
      () =>
        new DatabaseSessionService(
          {dbName: ':memory:', driver: SqliteDriver},
          {pool: {min: 2, max: 4}},
        ),
    ).toThrow('Overrides cannot be combined with an options object');
  });
});

describe('DatabaseSessionService row-level locking gate', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    // The suite above leaves a backend name stubbed on the shared probe, so
    // reset it and let this suite read the live sqlite backend.
    vi.mocked(getDatabaseBackend).mockReset();
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await service.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close();
  });

  /**
   * The lock mode `appendEvent` looks the session row up with. adk-python's
   * `test_append_event_locks_only_scopes_with_deltas` also drives sqlite, so
   * it too can only observe that no lock is requested.
   *
   * @returns The requested lock mode, or undefined when none was requested.
   */
  async function sessionLookupLockMode(): Promise<LockMode | undefined> {
    const session = await service.createSession({
      appName: 'lock-app',
      userId: 'lock-user',
      sessionId: 'lock-session',
    });

    const findOne = vi.spyOn(EntityManager.prototype, 'findOne');
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', invocationId: 'lock-invocation'}),
    });

    const lookup = findOne.mock.calls.find(
      ([entity]) => entity === StorageSession,
    );
    if (!lookup) {
      expect.fail('appendEvent did not look the session row up');
    }
    return lookup[2]?.lockMode;
  }

  it('test_append_event_locks_only_scopes_with_deltas[no_state_delta]', async () => {
    expect(await sessionLookupLockMode()).toBeUndefined();
  });

  it('asks the same lock mode the sqlite backend maps to', async () => {
    expect(sessionLockMode('sqlite')).toBeUndefined();
    expect(await sessionLookupLockMode()).toBe(sessionLockMode('sqlite'));
  });

  it('reads the live backend name rather than a constant', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      allowGlobalContext: true,
    });
    try {
      expect(getDatabaseBackend(orm)).toBe('sqlite');
      expect(sessionLockMode(getDatabaseBackend(orm))).toBeUndefined();
    } finally {
      await orm.close();
    }
  });
});

describe('dialectOf', () => {
  it('normalizes the name knex gives the sqlite dialect', () => {
    expect(dialectOf({getKnex: () => ({client: {dialect: 'sqlite3'}})})).toBe(
      'sqlite',
    );
  });

  it('passes a dialect name through unchanged', () => {
    expect(
      dialectOf({getKnex: () => ({client: {dialect: 'postgresql'}})}),
    ).toBe('postgresql');
  });

  it('names no backend for a connection without a knex handle', () => {
    expect(dialectOf({})).toBe('');
  });

  it('names no backend for a knex client naming no dialect', () => {
    expect(dialectOf({getKnex: () => ({client: {}})})).toBe('');
  });
});
