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
  Session,
  SessionNotFoundError,
  StaleSessionError,
  State,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {isDatabaseConnectionString} from '../../src/sessions/database_session_service.js';
import {validateDatabaseSchemaVersion} from '../../src/sessions/db/operations.js';
import {ENTITIES} from '../../src/sessions/db/schema.js';

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
      'Unsupported database URI',
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
