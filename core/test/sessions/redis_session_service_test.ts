/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  RedisClientLike,
  RedisSessionService,
  RedisSetOptions,
  Session,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  appStateKey,
  escapeGlob,
  isRedisConnectionString,
  sessionKey,
  userStateKey,
} from '../../src/sessions/redis_session_service.js';

import {logger} from '../../src/utils/logger.js';

const APP = 'app1';
const KEY_PREFIX = 'test:session:';
const TTL_SECONDS = 3600;

/** Matches a Redis glob pattern, honouring `\` escapes as Redis does. */
function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      source += escapeRegExpChar(pattern[++index]);
    } else if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExpChar(char: string): string {
  return /[a-zA-Z0-9_]/.test(char) ? char : `\\${char}`;
}

/**
 * An in-memory stand-in for a node-redis client, with a virtual clock so a
 * test can watch a key expire.
 */
class FakeRedis implements RedisClientLike {
  /** Number of `SET` commands received, so a test can assert "no write". */
  setCount = 0;
  /** Number of `close()` calls, so a test can assert the client is untouched. */
  closeCount = 0;

  private readonly values = new Map<string, string>();
  private readonly ttls = new Map<string, number | undefined>();
  private readonly writtenAt = new Map<string, number>();
  private clock = 0;

  advanceTime(seconds: number): void {
    this.clock += seconds;
  }

  /** The TTL recorded for a live key, or `undefined` when it has none. */
  ttlOf(key: string): number | undefined {
    this.evictIfExpired(key);
    return this.ttls.get(key);
  }

  /** The raw stored payload of a live key. */
  rawValue(key: string): string | undefined {
    this.evictIfExpired(key);
    return this.values.get(key);
  }

  async get(key: string): Promise<string | null> {
    this.evictIfExpired(key);
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<unknown> {
    this.setCount++;
    this.evictIfExpired(key);
    if (options?.NX && this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    this.ttls.set(key, options?.EX);
    this.writtenAt.set(key, this.clock);
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    this.ttls.delete(key);
    this.writtenAt.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async *scanIterator(options?: {MATCH?: string}): AsyncGenerator<string[]> {
    const matches = globToRegExp(options?.MATCH ?? '*');
    const batch = [...this.values.keys()].filter(
      (key) => !this.evictIfExpired(key) && matches.test(key),
    );
    yield batch;
  }

  async close(): Promise<void> {
    this.closeCount++;
  }

  private evictIfExpired(key: string): boolean {
    if (!this.values.has(key)) {
      return true;
    }
    const ttl = this.ttls.get(key);
    if (ttl !== undefined && ttl > 0) {
      if (this.clock - (this.writtenAt.get(key) ?? 0) >= ttl) {
        this.values.delete(key);
        this.ttls.delete(key);
        this.writtenAt.delete(key);
        return true;
      }
    }
    return false;
  }
}

describe('RedisSessionService', () => {
  let fake: FakeRedis;
  let service: RedisSessionService;

  beforeEach(() => {
    fake = new FakeRedis();
    service = new RedisSessionService({
      client: fake,
      ttlSeconds: TTL_SECONDS,
      keyPrefix: KEY_PREFIX,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Creates a session whose `lastUpdateTime` is pinned to `time`. */
  async function createSessionAt(
    time: number,
    sessionId: string,
    userId = 'u1',
  ): Promise<Session> {
    vi.spyOn(Date, 'now').mockReturnValue(time);
    const session = await service.createSession({
      appName: APP,
      userId,
      sessionId,
    });
    vi.mocked(Date.now).mockRestore();
    return session;
  }

  it('creates a session and returns the merged app, user and session state', async () => {
    const session = await service.createSession({
      appName: APP,
      userId: 'user1',
      state: {'key1': 'val1', 'user:pref': 'dark', 'app:version': '1.0'},
    });

    expect(session.appName).toBe(APP);
    expect(session.userId).toBe('user1');
    expect(session.id).not.toBe('');
    expect(session.state['key1']).toBe('val1');
    expect(session.state['user:pref']).toBe('dark');
    expect(session.state['app:version']).toBe('1.0');
  });

  it('rejects a create for a session id that already exists', async () => {
    await service.createSession({
      appName: APP,
      userId: 'user1',
      sessionId: 'sess_123',
    });

    await expect(
      service.createSession({
        appName: APP,
        userId: 'user1',
        sessionId: 'sess_123',
      }),
    ).rejects.toThrow('Session with id sess_123 already exists.');
  });

  it('round-trips a created session', async () => {
    const created = await service.createSession({
      appName: APP,
      userId: 'user1',
      sessionId: 'sess_abc',
      state: {foo: 'bar'},
    });

    const fetched = await service.getSession({
      appName: APP,
      userId: 'user1',
      sessionId: 'sess_abc',
    });

    expect(fetched?.id).toBe(created.id);
    expect(fetched?.state['foo']).toBe('bar');
    expect(fetched?.lastUpdateTime).toBe(created.lastUpdateTime);
  });

  it('resolves to undefined for a session that does not exist', async () => {
    await expect(
      service.getSession({
        appName: APP,
        userId: 'user1',
        sessionId: 'nonexistent',
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps only the last events when numRecentEvents is set', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    for (let index = 0; index < 5; index++) {
      await service.appendEvent({
        session,
        event: createEvent({author: `user_${index}`}),
      });
    }

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: session.id,
      config: {numRecentEvents: 2},
    });

    expect(fetched?.events.map((event) => event.author)).toEqual([
      'user_3',
      'user_4',
    ]);
  });

  it('returns no events when numRecentEvents is zero', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    for (let index = 0; index < 5; index++) {
      await service.appendEvent({
        session,
        event: createEvent({author: `user_${index}`}),
      });
    }

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: session.id,
      config: {numRecentEvents: 0},
    });

    expect(fetched?.events).toEqual([]);
  });

  it('keeps events at or after afterTimestamp', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    for (let index = 0; index < 5; index++) {
      await service.appendEvent({
        session,
        event: createEvent({author: `user_${index}`, timestamp: 100 + index}),
      });
    }

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: session.id,
      config: {afterTimestamp: 103},
    });

    expect(fetched?.events.map((event) => event.author)).toEqual([
      'user_3',
      'user_4',
    ]);
  });

  it('lists sessions for one user, and for every user when userId is omitted', async () => {
    await service.createSession({appName: APP, userId: 'u1', sessionId: 's1'});
    await service.createSession({appName: APP, userId: 'u1', sessionId: 's2'});
    await service.createSession({appName: APP, userId: 'u2', sessionId: 's3'});

    const forUser = await service.listSessions({appName: APP, userId: 'u1'});
    expect(forUser.sessions.map((session) => session.id).sort()).toEqual([
      's1',
      's2',
    ]);

    const forApp = await service.listSessions({appName: APP});
    expect(forApp.sessions.map((session) => session.id).sort()).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('deletes a session without deleting the user state', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 'to_delete',
      state: {'user:theme': 'dark'},
    });

    await service.deleteSession({
      appName: APP,
      userId: 'u1',
      sessionId: 'to_delete',
    });

    await expect(
      service.getSession({
        appName: APP,
        userId: 'u1',
        sessionId: 'to_delete',
      }),
    ).resolves.toBeUndefined();
    expect(fake.rawValue(userStateKey(KEY_PREFIX, APP, 'u1'))).toContain(
      'dark',
    );
  });

  it('shares user-scoped state written at create time with the next session', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark', 'user:locale': 'en'},
    });

    const second = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's2',
    });

    expect(second.state['user:theme']).toBe('dark');
    expect(second.state['user:locale']).toBe('en');
  });

  it('persists an event and the state delta of every scope', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'agent',
        actions: createEventActions({
          stateDelta: {'count': 1, 'user:score': 100, 'app:status': 'active'},
        }),
      }),
    });

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: session.id,
    });

    expect(fetched?.events).toHaveLength(1);
    expect(fetched?.state['count']).toBe(1);
    expect(fetched?.state['user:score']).toBe(100);
    expect(fetched?.state['app:status']).toBe('active');
  });

  it('writes the configured TTL onto the session, user and app keys', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo'},
    });

    expect(fake.ttlOf(sessionKey(KEY_PREFIX, APP, 'u1', 's1'))).toBe(
      TTL_SECONDS,
    );
    expect(fake.ttlOf(userStateKey(KEY_PREFIX, APP, 'u1'))).toBe(TTL_SECONDS);
    expect(fake.ttlOf(appStateKey(KEY_PREFIX, APP))).toBe(TTL_SECONDS);
  });

  it('stops returning a session, its listing and its user state once the TTL passes', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo', 'key1': 'val1'},
    });

    fake.advanceTime(TTL_SECONDS + 1);

    await expect(
      service.getSession({appName: APP, userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeUndefined();
    const listed = await service.listSessions({appName: APP, userId: 'u1'});
    expect(listed.sessions).toEqual([]);

    const fresh = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's2',
    });
    expect(Object.keys(fresh.state)).toEqual([]);
  });

  it('stores only session-scoped state, in a snake_case envelope', async () => {
    const session = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {
        'topic': 'weather',
        'user:pref': 'dark',
        'app:env': 'prod',
        'temp:scratch': 'temp_value',
      },
    });

    expect(session.state['topic']).toBe('weather');
    expect(session.state['user:pref']).toBe('dark');
    expect(session.state['app:env']).toBe('prod');
    expect(session.state['temp:scratch']).toBe('temp_value');

    const raw = fake.rawValue(sessionKey(KEY_PREFIX, APP, 'u1', 's1'));
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw as string);
    expect(stored.state).toEqual({topic: 'weather'});
    expect(stored.app_name).toBe(APP);
    expect(stored.user_id).toBe('u1');
    expect(stored.last_update_time).toBe(session.lastUpdateTime);
  });

  it('reflects a user state delta written by one session in another', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark', 's1_key': 'val1'},
    });
    const second = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's2',
    });

    await service.appendEvent({
      session: second,
      event: createEvent({
        author: 'agent',
        actions: createEventActions({stateDelta: {'user:theme': 'light'}}),
      }),
    });

    const reloaded = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded?.state['user:theme']).toBe('light');
    expect(reloaded?.state['s1_key']).toBe('val1');
  });

  it('returns temp state to the caller but never persists it', async () => {
    const session = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'temp:code': 1234, 'persist_me': 'yes'},
    });
    expect(session.state['temp:code']).toBe(1234);

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(fetched?.state['temp:code']).toBeUndefined();
    expect(fetched?.state['persist_me']).toBe('yes');
  });

  it('merges the app and user state into every listed session', async () => {
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:lang': 'en', 'app:mode': 'fast', 's1': 1},
    });
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's2',
      state: {s2: 2},
    });

    const listed = await service.listSessions({appName: APP, userId: 'u1'});

    expect(listed.sessions).toHaveLength(2);
    for (const session of listed.sessions) {
      expect(session.state['user:lang']).toBe('en');
      expect(session.state['app:mode']).toBe('fast');
    }
  });

  it('accumulates user state across sessions without leaking session state', async () => {
    const first = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark', 's1_key': 'val1'},
    });
    expect(first.state['user:lang']).toBeUndefined();

    const second = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's2',
      state: {'user:lang': 'en', 's2_key': 'val2'},
    });
    expect(second.state['user:theme']).toBe('dark');
    expect(second.state['user:lang']).toBe('en');
    expect(second.state['s1_key']).toBeUndefined();

    const reloaded = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded?.state['user:theme']).toBe('dark');
    expect(reloaded?.state['user:lang']).toBe('en');
    expect(reloaded?.state['s2_key']).toBeUndefined();
  });

  describe('listSessions pagination', () => {
    beforeEach(async () => {
      await createSessionAt(1000, 's1');
      await createSessionAt(2000, 's2');
      await createSessionAt(3000, 's3');
    });

    it('reports the full result set when no pagination is requested', async () => {
      const listed = await service.listSessions({appName: APP, userId: 'u1'});
      expect(listed.sessions.map((session) => session.id)).toEqual([
        's3',
        's2',
        's1',
      ]);
      expect(listed).toMatchObject({
        page: 1,
        limit: 3,
        totalItems: 3,
        totalPages: 1,
      });
    });

    it('applies limit and offset', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        limit: 2,
        offset: 2,
      });
      expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
      expect(listed).toMatchObject({
        page: 2,
        limit: 2,
        totalItems: 3,
        totalPages: 2,
      });
    });

    it('lets page take precedence over offset', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        limit: 2,
        offset: 0,
        page: 2,
      });
      expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
      expect(listed.page).toBe(2);
    });

    it('returns nothing for a limit of zero', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        limit: 0,
      });
      expect(listed).toEqual({
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 3,
        totalPages: 0,
      });
    });

    it('applies an offset given without a limit', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        offset: 1,
      });
      expect(listed.sessions.map((session) => session.id)).toEqual([
        's2',
        's1',
      ]);
      expect(listed).toMatchObject({page: 1, limit: 3, totalPages: 1});
    });

    it('reports zero pages for an app with no sessions', async () => {
      const listed = await service.listSessions({appName: 'empty_app'});
      expect(listed).toEqual({
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 0,
        totalPages: 0,
      });
    });
  });

  describe('listSessions ordering', () => {
    beforeEach(async () => {
      await createSessionAt(2000, 's2');
      await createSessionAt(1000, 's1');
      await createSessionAt(3000, 's3');
    });

    it('orders by last update time descending by default', async () => {
      const listed = await service.listSessions({appName: APP, userId: 'u1'});
      expect(listed.sessions.map((session) => session.id)).toEqual([
        's3',
        's2',
        's1',
      ]);
    });

    it('honours an explicit ascending order', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        order: 'asc',
      });
      expect(listed.sessions.map((session) => session.id)).toEqual([
        's1',
        's2',
        's3',
      ]);
    });

    it('honours an explicit descending order', async () => {
      const listed = await service.listSessions({
        appName: APP,
        userId: 'u1',
        order: 'desc',
      });
      expect(listed.sessions.map((session) => session.id)).toEqual([
        's3',
        's2',
        's1',
      ]);
    });

    it('breaks a last-update-time tie by session id', async () => {
      await createSessionAt(4000, 'sb', 'u2');
      await createSessionAt(4000, 'sa', 'u2');

      const listed = await service.listSessions({appName: APP, userId: 'u2'});
      expect(listed.sessions.map((session) => session.id)).toEqual([
        'sa',
        'sb',
      ]);
    });

    it('keeps both sessions when two users share a session id and update time', async () => {
      await createSessionAt(5000, 'shared', 'ua');
      await createSessionAt(5000, 'shared', 'ub');

      const listed = await service.listSessions({appName: APP});
      const shared = listed.sessions.filter(
        (session) => session.id === 'shared',
      );
      expect(shared.map((session) => session.userId).sort()).toEqual([
        'ua',
        'ub',
      ]);
    });
  });

  describe('glob escaping', () => {
    it('escapes every Redis glob metacharacter', () => {
      expect(escapeGlob('a*b?c[d]e^f\\g')).toBe('a\\*b\\?c\\[d\\]e\\^f\\\\g');
    });

    it('does not let a wildcard user id widen the scan', async () => {
      await service.createSession({
        appName: APP,
        userId: 'u1',
        sessionId: 'mine',
      });
      await service.createSession({
        appName: APP,
        userId: '*',
        sessionId: 'wildcard',
      });

      const listed = await service.listSessions({appName: APP, userId: '*'});

      expect(listed.sessions.map((session) => session.id)).toEqual([
        'wildcard',
      ]);
    });

    it('does not let a bracketed user id widen the scan', async () => {
      await service.createSession({
        appName: APP,
        userId: 'u1',
        sessionId: 'mine',
      });
      await service.createSession({
        appName: APP,
        userId: '[u1]',
        sessionId: 'bracketed',
      });

      const listed = await service.listSessions({
        appName: APP,
        userId: '[u1]',
      });

      expect(listed.sessions.map((session) => session.id)).toEqual([
        'bracketed',
      ]);
    });
  });

  it('writes nothing for a partial event', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    const writesBefore = fake.setCount;

    const event = createEvent({author: 'agent', partial: true});
    const returned = await service.appendEvent({session, event});

    expect(returned).toBe(event);
    expect(fake.setCount).toBe(writesBefore);
  });

  it('skips a key that expires between the scan and the read', async () => {
    class VanishingKeyRedis extends FakeRedis {
      override async *scanIterator(options?: {
        MATCH?: string;
      }): AsyncGenerator<string[]> {
        for await (const batch of super.scanIterator(options)) {
          yield [...batch, sessionKey(KEY_PREFIX, APP, 'u1', 'vanished')];
        }
      }
    }
    const vanishing = new VanishingKeyRedis();
    const vanishingService = new RedisSessionService({
      client: vanishing,
      keyPrefix: KEY_PREFIX,
    });
    await vanishingService.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
    });

    const listed = await vanishingService.listSessions({
      appName: APP,
      userId: 'u1',
    });

    expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
  });

  it('skips a key whose payload is not JSON and keeps listing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await service.createSession({appName: APP, userId: 'u1', sessionId: 's1'});
    await fake.set(sessionKey(KEY_PREFIX, APP, 'u1', 'broken'), 'not json');

    const listed = await service.listSessions({appName: APP, userId: 'u1'});

    expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips a key whose payload is valid JSON but not a session', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await service.createSession({
      appName: 'user_state',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark'},
    });

    const listed = await service.listSessions({appName: 'user_state'});

    expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reads an unreadable session payload as a missing session', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await fake.set(sessionKey(KEY_PREFIX, APP, 'u1', 's1'), 'not json');

    await expect(
      service.getSession({appName: APP, userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stores events in snake_case and reads them back in camelCase', async () => {
    const session = await service.createSession({appName: APP, userId: 'u1'});
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'agent',
        invocationId: 'inv-1',
        actions: createEventActions({
          stateDelta: {'user:score': 100, 'plain_key': 'kept'},
        }),
      }),
    });

    const raw = fake.rawValue(sessionKey(KEY_PREFIX, APP, 'u1', session.id));
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw as string);
    expect(stored.events[0].invocation_id).toBe('inv-1');
    expect(stored.events[0].actions.state_delta).toEqual({
      'user:score': 100,
      'plain_key': 'kept',
    });

    const fetched = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: session.id,
    });
    expect(fetched?.events[0].invocationId).toBe('inv-1');
    expect(fetched?.events[0].actions.stateDelta).toEqual({
      'user:score': 100,
      'plain_key': 'kept',
    });
  });

  it('writes no expiry when ttlSeconds is zero', async () => {
    const noTtlService = new RedisSessionService({
      client: fake,
      ttlSeconds: 0,
      keyPrefix: KEY_PREFIX,
    });

    await noTtlService.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo'},
    });

    const key = sessionKey(KEY_PREFIX, APP, 'u1', 's1');
    expect(fake.rawValue(key)).toBeDefined();
    expect(fake.ttlOf(key)).toBeUndefined();
    expect(fake.ttlOf(userStateKey(KEY_PREFIX, APP, 'u1'))).toBeUndefined();
    expect(fake.ttlOf(appStateKey(KEY_PREFIX, APP))).toBeUndefined();
  });

  it('leaves an injected client open when close is called', async () => {
    await service.createSession({appName: APP, userId: 'u1', sessionId: 's1'});

    await service.close();

    expect(fake.closeCount).toBe(0);
    await expect(
      service.getSession({appName: APP, userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeDefined();
  });

  it('closes safely when no client was ever built', async () => {
    const unusedService = new RedisSessionService();

    await expect(unusedService.close()).resolves.toBeUndefined();
    await expect(unusedService.close()).resolves.toBeUndefined();
  });

  describe('isRedisConnectionString', () => {
    it('accepts the redis schemes', () => {
      expect(isRedisConnectionString('redis://localhost:6379/0')).toBe(true);
      expect(isRedisConnectionString('rediss://localhost:6380')).toBe(true);
    });

    it('rejects another scheme and a missing uri', () => {
      expect(isRedisConnectionString('postgres://localhost:5432/db')).toBe(
        false,
      );
      expect(isRedisConnectionString(undefined)).toBe(false);
    });
  });
});
