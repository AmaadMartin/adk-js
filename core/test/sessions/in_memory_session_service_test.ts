/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  InMemorySessionService,
  Session,
  SessionNotFoundError,
  State,
  createEvent,
  createEventActions,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {isInMemoryConnectionString} from '../../src/sessions/in_memory_session_service.js';

// A `'__proto__': value` pair in an object literal invokes the prototype
// setter instead of creating an own key, so it cannot express what an attacker
// actually sends. `JSON.parse` is what the dev server does with a request
// body, and it does produce an own `__proto__` key.
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

describe('isInMemoryConnectionString', () => {
  it('returns true for memory://', () => {
    expect(isInMemoryConnectionString('memory://')).toBe(true);
  });

  it('returns false for other strings', () => {
    expect(isInMemoryConnectionString('postgres://localhost:5432')).toBe(false);
    expect(isInMemoryConnectionString('memory:/')).toBe(false);
    expect(isInMemoryConnectionString('')).toBe(false);
    expect(isInMemoryConnectionString(undefined)).toBe(false);
  });
});

describe('InMemorySessionService', () => {
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  describe('createSession', () => {
    it('creates a new session with correct properties', async () => {
      const appName = 'test-app';
      const userId = 'test-user';
      const state = {key: 'value'};

      const session = await service.createSession({appName, userId, state});

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.appName).toBe(appName);
      expect(session.userId).toBe(userId);
      expect(session.state).toEqual(state);
      expect(session.events).toEqual([]);
      expect(session.lastUpdateTime).toBeDefined();
    });

    it('creates a session with a provided sessionId', async () => {
      const sessionId = 'custom-session-id';
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
        sessionId,
      });

      expect(session.id).toBe(sessionId);
    });

    it('merges existing app and user state into new session', async () => {
      // First, create a session and add some state
      const appName = 'shared-app';
      const userId = 'shared-user';
      const session1 = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}appKey`]: 'appValue',
            [`${State.USER_PREFIX}userKey`]: 'userValue',
          },
        }),
      });
      await service.appendEvent({session: session1, event});

      // Now create a new session for the same user and app
      const session2 = await service.createSession({appName, userId});

      expect(session2.state).toEqual({
        [`${State.APP_PREFIX}appKey`]: 'appValue',
        [`${State.USER_PREFIX}userKey`]: 'userValue',
      });
    });

    it('filters out temporary state keys prefixed with temp:', async () => {
      const appName = 'test-app';
      const userId = 'test-user';
      const state = {
        normalKey: 'value',
        [`${State.TEMP_PREFIX}tempKey`]: 'tempValue',
      };

      const session = await service.createSession({appName, userId, state});

      expect(session.state).toHaveProperty('normalKey', 'value');
      expect(session.state).not.toHaveProperty(`${State.TEMP_PREFIX}tempKey`);
    });
  });

  describe('getSession', () => {
    it('returns undefined if session does not exist', async () => {
      const session = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: 'non-existent',
      });
      expect(session).toBeUndefined();
    });

    it('returns the session if it exists', async () => {
      const createdSession = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      const session = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: createdSession.id,
      });

      expect(session).toBeDefined();
      expect(session?.id).toBe(createdSession.id);
    });

    it('respects numRecentEvents config', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {numRecentEvents: 2},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(3);
      expect(retrievedSession?.events[1].timestamp).toBe(4);
    });

    it('respects afterTimestamp config', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {afterTimestamp: 2500},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(3000);
      expect(retrievedSession?.events[1].timestamp).toBe(4000);
    });

    it('merges current state into retrieved session', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});

      // Update state in another session (simulated by directly modifying internal state or another session)
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}key`]: 'newValue',
          },
        }),
      });
      await service.appendEvent({session, event});

      const retrievedSession = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(retrievedSession?.state).toEqual({
        [`${State.APP_PREFIX}key`]: 'newValue',
      });
    });
  });

  describe('listSessions', () => {
    it('returns empty list if no sessions exist', async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'user',
      });
      expect(response.sessions).toEqual([]);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(0);
      expect(response.totalItems).toBe(0);
      expect(response.totalPages).toBe(0);
    });

    it('returns list of sessions without events', async () => {
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId});
      await service.createSession({appName, userId});

      const response = await service.listSessions({appName, userId});

      expect(response.sessions).toHaveLength(2);
      expect(response.sessions[0].events).toEqual([]);
      expect(response.sessions[1].events).toEqual([]);
    });

    it('lists every user of the app when userId is omitted', async () => {
      const appName = 'app';
      await service.createSession({appName, userId: 'user1'});
      await service.createSession({appName, userId: 'user2'});
      await service.createSession({appName: 'other-app', userId: 'user1'});

      const response = await service.listSessions({appName});

      expect(response.sessions).toHaveLength(2);
      expect(response.sessions.map((s) => s.userId).sort()).toEqual([
        'user1',
        'user2',
      ]);
      expect(response.totalItems).toBe(2);
    });

    it('limit on empty result → returns pagination metadata with zeros', async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'user',
        limit: 10,
      });
      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(0);
      expect(response.totalPages).toBe(0);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(10);
    });

    it('no pagination params → returns all sessions with page=1', async () => {
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId});
      await service.createSession({appName, userId});

      const response = await service.listSessions({appName, userId});

      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('order asc returns oldest-first', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
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

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('order desc returns newest-first', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
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

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    });

    it('tie-breaking by id when lastUpdateTime values are equal', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
      });

      const asc = await service.listSessions({appName, userId, order: 'asc'});
      expect(asc.sessions.map((s) => s.id)).toEqual(['s1', 's2']);

      const desc = await service.listSessions({appName, userId, order: 'desc'});
      expect(desc.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('limit returns only N sessions', async () => {
      const appName = 'app';
      const userId = 'user';
      for (let i = 1; i <= 5; i++) {
        await service.createSession({appName, userId, sessionId: `s${i}`});
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
    });

    it('offset skips N sessions', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 2000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 3000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 1,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3']);
    });

    it('page + limit returns correct slice', async () => {
      const appName = 'app';
      const userId = 'user';
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

    it('offset beyond total → empty sessions with correct metadata', async () => {
      const appName = 'app';
      const userId = 'user';
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
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({appName, userId, limit: 0});

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(0);
    });

    it('order without limit returns all sessions sorted with page=1', async () => {
      const appName = 'app';
      const userId = 'user';
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
      const appName = 'app';
      const userId = 'user';
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

      // page=2, limit=2 → sessions 3,4; offset=0 should be ignored
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

  describe('deleteSession', () => {
    it('deletes an existing session', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      await service.deleteSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession).toBeUndefined();
    });

    it('does nothing if session does not exist', async () => {
      await expect(
        service.deleteSession({
          appName: 'app',
          userId: 'user',
          sessionId: 'non-existent',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('appendEvent', () => {
    it('appends event to session and updates lastUpdateTime', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      const timestamp = Date.now() + 1000;
      const event = createEvent({timestamp});

      await service.appendEvent({session, event});

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession?.events).toHaveLength(1);
      expect(retrievedSession?.events[0]).toEqual(event);
      expect(retrievedSession?.lastUpdateTime).toBe(timestamp);
    });

    it('updates app state', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}key`]: 'value',
          },
        }),
      });

      await service.appendEvent({session, event});

      // Check via side channel (create another session to see if state persists)
      const session2 = await service.createSession({appName, userId});
      expect(session2.state).toHaveProperty(`${State.APP_PREFIX}key`, 'value');
    });

    it('updates user state', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.USER_PREFIX}key`]: 'value',
          },
        }),
      });

      await service.appendEvent({session, event});

      const session2 = await service.createSession({appName, userId});
      expect(session2.state).toHaveProperty(`${State.USER_PREFIX}key`, 'value');
    });

    // adk-python: tests/unittests/sessions/test_session_service.py::test_append_event_to_unknown_session_raises_session_not_found
    it('throws SessionNotFoundError for a session the service never created', async () => {
      const session: Session = {
        id: 'fake-session',
        appName: 'fake-app',
        userId: 'fake-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now()});

      await expect(service.appendEvent({session, event})).rejects.toThrow(
        SessionNotFoundError,
      );
      await expect(service.appendEvent({session, event})).rejects.toThrow(
        'Session fake-session not found.',
      );
    });

    // adk-python: tests/unittests/sessions/test_session_service.py::test_append_event_to_deleted_session_raises_session_not_found
    it('throws SessionNotFoundError after the session is deleted', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      await service.deleteSession({appName, userId, sessionId: session.id});

      await expect(
        service.appendEvent({session, event: createEvent({timestamp: 1000})}),
      ).rejects.toThrow(SessionNotFoundError);
    });

    it('throws for a known app whose user is unknown', async () => {
      const appName = 'app';
      await service.createSession({appName, userId: 'known-user'});
      const session: Session = {
        id: 'other-session',
        appName,
        userId: 'unknown-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };

      await expect(
        service.appendEvent({session, event: createEvent({timestamp: 1000})}),
      ).rejects.toThrow(SessionNotFoundError);
    });

    it('leaves the app and user stores untouched when the session is unknown', async () => {
      const appName = 'app';
      const userId = 'user';
      const known = await service.createSession({appName, userId});
      const stale: Session = {
        id: 'stale-session',
        appName,
        userId,
        state: {},
        events: [],
        lastUpdateTime: 0,
      };

      await expect(
        service.appendEvent({
          session: stale,
          event: createEvent({
            timestamp: 1000,
            actions: createEventActions({
              stateDelta: {[`${State.APP_PREFIX}key`]: 'value'},
            }),
          }),
        }),
      ).rejects.toThrow(SessionNotFoundError);

      const sibling = await service.getSession({
        appName,
        userId,
        sessionId: known.id,
      });
      expect(sibling?.state).toEqual({});
      expect(stale.events).toEqual([]);
    });

    // adk-python: in_memory_session_service.py::append_event returns before the
    // store lookup when `event.partial` is set.
    it('returns a partial event for an unknown session without throwing', async () => {
      const session: Session = {
        id: 'fake-session',
        appName: 'fake-app',
        userId: 'fake-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now(), partial: true});

      await expect(service.appendEvent({session, event})).resolves.toBe(event);
    });

    it('does not stamp lastUpdateTime for a partial event', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      const before = session.lastUpdateTime;

      await service.appendEvent({
        session,
        event: createEvent({timestamp: before + 5000, partial: true}),
      });

      expect(session.lastUpdateTime).toBe(before);
      const stored = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      expect(stored?.lastUpdateTime).toBe(before);
      expect(stored?.events).toEqual([]);
    });
  });

  describe('prototype pollution', () => {
    // Every key that any test below can plant on `Object.prototype` when the
    // fix is reverted, so that reverting it fails these tests instead of
    // corrupting the ones that run afterwards. `sessions['app1']['__proto__']`
    // resolves to `Object.prototype`, so the *session id* lands there too, and
    // `sessions['__proto__']` does the same for the *user id*.
    const POLLUTED_KEYS = [
      'polluted',
      'httpOptions',
      'pwned',
      'baseUrl',
      'poc_sid',
      'isAdmin',
      'u1',
      's1',
    ];

    const clearPollution = () => {
      for (const key of POLLUTED_KEYS) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    };

    beforeEach(clearPollution);
    afterEach(clearPollution);

    it('does not pollute Object.prototype via appName', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('does not pollute Object.prototype via userId in user state', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: '__proto__',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {
              [`${State.USER_PREFIX}httpOptions`]: {
                baseUrl: 'https://evil.test',
              },
            },
          }),
        }),
      });

      expect(({} as Record<string, unknown>)['httpOptions']).toBeUndefined();
    });

    it('does not pollute Object.prototype via appName in app state', async () => {
      const session = await service.createSession({
        appName: '__proto__',
        userId: 'u1',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {[`${State.APP_PREFIX}pwned`]: 'attacker-value'},
          }),
        }),
      });

      expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
    });

    it('keeps a __proto__ user state key as an own property', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {
              [`${State.USER_PREFIX}__proto__`]: {
                baseUrl: 'https://evil.test',
              },
            },
          }),
        }),
      });

      // Read the key back through a *second* session. `updateSessionState`
      // also writes the prefixed key into the originating session's own state,
      // so only a sibling session exercises the `userState` map: writing
      // `__proto__` into a plain map re-parents it rather than storing an own
      // key, and `mergeStates` then silently drops the entry for every other
      // session of the same user.
      const sibling = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's2',
      });
      expect(sibling.state[`${State.USER_PREFIX}__proto__`]).toEqual({
        baseUrl: 'https://evil.test',
      });
    });

    it('does not re-parent session state via __proto__ in the initial state', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
        state: parseBody('{"__proto__": {"isAdmin": true}}'),
      });

      // `State` looks keys up with `in`, so a re-parented state object hands
      // back every key of the attacker's object as if it were session state.
      expect(new State(session.state).get('isAdmin')).toBeUndefined();
      expect(session.state['__proto__']).toEqual({isAdmin: true});
    });

    it('does not re-parent session state via __proto__ in a state delta', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: parseBody('{"__proto__": {"isAdmin": true}}'),
          }),
        }),
      });

      const stored = await service.getSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(new State(stored!.state).get('isAdmin')).toBeUndefined();
      expect(stored?.state['__proto__']).toEqual({isAdmin: true});
    });

    it('does not leak sessions across apps as phantom entries', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      // An app/user pair that was never created must stay empty.
      const phantom = await service.listSessions({
        appName: 'polluted',
        userId: 'polluted',
      });
      expect(phantom.sessions).toHaveLength(0);

      // A real, unrelated app must not gain a phantom user either.
      await service.createSession({
        appName: 'real_app',
        userId: 'alice',
        sessionId: 's1',
      });
      const phantomUser = await service.listSessions({
        appName: 'real_app',
        userId: 'polluted',
      });
      expect(phantomUser.sessions).toHaveLength(0);
    });

    it('still stores and retrieves an app literally named __proto__', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      const session = await service.getSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
      });
      expect(session?.id).toBe('poc_sid');
    });
  });

  describe('light copy (IN_MEMORY_SESSION_SERVICE_LIGHT_COPY)', () => {
    const appName = 'app';
    const userId = 'user';

    beforeEach(() => {
      overrideFeatureEnabled(
        FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY,
        true,
      );
    });

    afterEach(() => {
      overrideFeatureEnabled(
        FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY,
        undefined,
      );
      delete (Object.prototype as Record<string, unknown>)['isAdmin'];
    });

    it('shares the stored event objects but not the events array', async () => {
      const session = await service.createSession({appName, userId});
      const event = createEvent({timestamp: 1000});
      await service.appendEvent({session, event});

      const first = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      const second = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(first?.events[0]).toBe(event);
      expect(first?.events).not.toBe(second?.events);
    });

    it('deep-clones the stored event objects with the flag off', async () => {
      overrideFeatureEnabled(
        FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY,
        false,
      );
      const session = await service.createSession({appName, userId});
      const event = createEvent({timestamp: 1000});
      await service.appendEvent({session, event});

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(retrieved?.events[0]).not.toBe(event);
      expect(retrieved?.events[0]).toEqual(event);
    });

    it('shares a nested state value between two reads', async () => {
      const nested = {inner: 'value'};
      const session = await service.createSession({
        appName,
        userId,
        state: {nested},
      });

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(retrieved?.state['nested']).toBe(nested);
    });

    it('deep-clones a nested state value with the flag off', async () => {
      overrideFeatureEnabled(
        FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY,
        false,
      );
      const nested = {inner: 'value'};
      const session = await service.createSession({
        appName,
        userId,
        state: {nested},
      });

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(retrieved?.state['nested']).not.toBe(nested);
      expect(retrieved?.state['nested']).toEqual(nested);
    });

    it('keeps the stored session unchanged when the caller edits its copy', async () => {
      const session = await service.createSession({appName, userId});
      await service.appendEvent({session, event: createEvent({timestamp: 1})});

      const copy = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      copy!.events.push(createEvent({timestamp: 2}));
      copy!.state['addedByCaller'] = true;

      const reread = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      expect(reread?.events).toHaveLength(1);
      expect(reread?.state).not.toHaveProperty('addedByCaller');
    });

    it('returns a null-prototype state map', async () => {
      const session = await service.createSession({appName, userId});

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(Object.getPrototypeOf(retrieved!.state)).toBeNull();
      expect('toString' in retrieved!.state).toBe(false);
    });

    it('merges existing app and user state into a new session', async () => {
      const session1 = await service.createSession({appName, userId});
      await service.appendEvent({
        session: session1,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {
              [`${State.APP_PREFIX}appKey`]: 'appValue',
              [`${State.USER_PREFIX}userKey`]: 'userValue',
            },
          }),
        }),
      });

      const session2 = await service.createSession({appName, userId});

      expect(session2.state).toEqual({
        [`${State.APP_PREFIX}appKey`]: 'appValue',
        [`${State.USER_PREFIX}userKey`]: 'userValue',
      });
    });

    it('respects numRecentEvents config', async () => {
      const session = await service.createSession({appName, userId});
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i}),
        });
      }

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
        config: {numRecentEvents: 2},
      });

      expect(retrieved?.events.map((e) => e.timestamp)).toEqual([3, 4]);
    });

    it('respects afterTimestamp config', async () => {
      const session = await service.createSession({appName, userId});
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
        config: {afterTimestamp: 2500},
      });

      expect(retrieved?.events.map((e) => e.timestamp)).toEqual([3000, 4000]);
    });

    it('does not re-parent session state via __proto__ in a state delta', async () => {
      const session = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: parseBody('{"__proto__": {"isAdmin": true}}'),
          }),
        }),
      });

      const stored = await service.getSession({
        appName,
        userId,
        sessionId: 's1',
      });
      expect(new State(stored!.state).get('isAdmin')).toBeUndefined();
      expect(stored?.state['__proto__']).toEqual({isAdmin: true});
    });
  });
});
