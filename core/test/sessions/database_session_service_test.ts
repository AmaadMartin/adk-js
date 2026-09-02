/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  DatabaseSessionService,
  Event,
  State,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
import {validateDatabaseSchemaVersion} from '../../src/sessions/db/operations.js';
import {ENTITIES, StorageSession} from '../../src/sessions/db/schema.js';
import {ENTITIES_V0, StorageEventV0} from '../../src/sessions/db/schema_v0.js';
import {logger} from '../../src/utils/logger.js';

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
    // MikroORM closing
    const orm = (service as unknown as {orm: MikroORM}).orm;
    if (orm) {
      await orm.close();
    }
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
    const internalService = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await internalService.init();
    const orm = (internalService as unknown as {orm: MikroORM}).orm as MikroORM;

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

      const em = (service as unknown as {orm: MikroORM}).orm.em.fork();
      const storedEvents = (await em.find('StorageEvent', {
        sessionId: 's-temp',
      })) as {sessionId: string; eventData: Event}[];
      const eventData = storedEvents[0].eventData;

      expect(eventData.actions?.stateDelta?.['keep']).toBe('me');
      expect(
        eventData.actions?.stateDelta?.[State.TEMP_PREFIX + 'hide'],
      ).toBeUndefined();
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

      const em = (service as unknown as {orm: MikroORM}).orm.em.fork();
      const storedSession = (await em.findOne('StorageSession', {
        id: 's-time',
      })) as {id: string; updateTime: Date};

      expect(storedSession.updateTime.getTime()).toBe(timestamp);
    });
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
  const READ_ONLY_MESSAGE =
    'adk-js can read such a database but cannot write to it';

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

  it('warns once that legacy actions come back empty', async () => {
    await service.getSession({appName, userId, sessionId});
    await service.getSession({appName, userId, sessionId});

    const actionWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('come back empty'),
    );
    expect(actionWarnings).toHaveLength(1);
  });

  it('refuses to create a session', async () => {
    await expect(
      service.createSession({appName, userId, sessionId: 's2'}),
    ).rejects.toThrow(READ_ONLY_MESSAGE);
  });

  it('refuses to append an event', async () => {
    const session = await service.getSession({appName, userId, sessionId});
    if (!session) {
      expect.fail('expected the seeded session to load');
    }

    await expect(
      service.appendEvent({session, event: createEvent({timestamp: 9000})}),
    ).rejects.toThrow(READ_ONLY_MESSAGE);
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
