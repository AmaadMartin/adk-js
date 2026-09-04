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
import {EntityManager, LockMode, MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isDatabaseConnectionString} from '../../src/sessions/database_session_service.js';
import {
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  validateDatabaseSchemaVersion,
} from '../../src/sessions/db/operations.js';
import {StorageSession} from '../../src/sessions/db/schema.js';

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

    // Test afterTimestamp
    const after2 = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {afterTimestamp: now},
    });
    expect(after2?.events.length).toBe(1);
    expect(after2?.events[0].id).toBe(e3.id);
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

describe('DatabaseSessionService lifecycle', () => {
  let databaseFile: string;

  beforeEach(() => {
    databaseFile = path.join(
      mkdtempSync(path.join(tmpdir(), 'adk-session-db-')),
      'sessions.db',
    );
  });

  afterEach(() => {
    rmSync(path.dirname(databaseFile), {recursive: true, force: true});
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
    writeFileSync(path.join(path.dirname(databaseFile), 'blocked'), '');
    const service = new DatabaseSessionService(
      `sqlite://${path.join(path.dirname(databaseFile), 'blocked', 'x.db')}`,
    );
    await expect(service.init()).rejects.toThrow(
      /^Failed to create database engine for URL 'sqlite:/,
    );

    await expect(service.close()).resolves.toBeUndefined();
  });

  it('retries a failed init', async () => {
    writeFileSync(path.join(path.dirname(databaseFile), 'blocked2'), '');
    const blockedPath = path.join(path.dirname(databaseFile), 'blocked2');
    const service = new DatabaseSessionService(
      `sqlite://${path.join(blockedPath, 'x.db')}`,
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
    const closed: DatabaseSessionService[] = [];
    {
      await using service = new DatabaseSessionService(
        `sqlite://${databaseFile}`,
      );
      vi.spyOn(service, 'close').mockImplementation(async () => {
        closed.push(service);
      });
      await service.init();
      expect(closed).toEqual([]);
    }

    expect(closed).toHaveLength(1);
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
