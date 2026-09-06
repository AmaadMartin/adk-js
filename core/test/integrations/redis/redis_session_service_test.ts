/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference test suite for `RedisSessionService`, ported test by test from
 * `tests/unittests/integrations/redis/test_redis_session_service.py` at
 * `google/adk-python` `main`. Each `it()` keeps its Python name so a reviewer
 * can grep the reference for it.
 */

import {
  AlreadyExistsError,
  createEvent,
  RedisSessionService,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  redisAppStateKey,
  redisSessionKey,
  redisUserStateKey,
} from '../../../src/integrations/redis/redis_session_service.js';

import {FakeRedis} from './fake_redis.js';

const TTL_SECONDS = 3600;
const KEY_PREFIX = 'test:session:';

describe('RedisSessionService (adk-python reference suite)', () => {
  let fakeRedis: FakeRedis;
  let sessionService: RedisSessionService;

  beforeEach(() => {
    fakeRedis = new FakeRedis();
    sessionService = new RedisSessionService({
      ttlSeconds: TTL_SECONDS,
      keyPrefix: KEY_PREFIX,
      client: fakeRedis,
    });
  });

  it('test_create_session', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
      state: {key1: 'val1', 'user:pref': 'dark', 'app:version': '1.0'},
    });

    expect(session.appName).toBe('app1');
    expect(session.userId).toBe('user1');
    expect(session.state['key1']).toBe('val1');
    expect(session.state['user:pref']).toBe('dark');
    expect(session.state['app:version']).toBe('1.0');
    expect(session.id).toBeTruthy();
  });

  it('test_create_session_already_exists', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'sess_123',
    });

    await expect(
      sessionService.createSession({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'sess_123',
      }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it('test_get_session', async () => {
    const created = await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'sess_abc',
      state: {foo: 'bar'},
    });

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'sess_abc',
    });

    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.state['foo']).toBe('bar');
  });

  it('test_get_session_not_found', async () => {
    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'nonexistent',
    });

    expect(fetched).toBeUndefined();
  });

  it('test_get_session_with_event_filter', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
    });

    for (let i = 0; i < 5; i++) {
      await sessionService.appendEvent({
        session,
        event: createEvent({author: `user_${i}`}),
      });
    }

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: session.id,
      config: {numRecentEvents: 2},
    });

    expect(fetched).toBeDefined();
    expect(fetched?.events).toHaveLength(2);
    expect(fetched?.events.at(-1)?.author).toBe('user_4');
  });

  it('test_get_session_with_num_recent_events_zero', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
    });

    for (let i = 0; i < 5; i++) {
      await sessionService.appendEvent({
        session,
        event: createEvent({author: `user_${i}`}),
      });
    }

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: session.id,
      config: {numRecentEvents: 0},
    });

    expect(fetched).toBeDefined();
    expect(fetched?.events).toEqual([]);
  });

  it('test_get_session_with_after_timestamp', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'user1',
    });

    for (let i = 0; i < 5; i++) {
      await sessionService.appendEvent({
        session,
        event: createEvent({author: `user_${i}`, timestamp: 100 + i}),
      });
    }

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: session.id,
      config: {afterTimestamp: 103},
    });

    expect(fetched).toBeDefined();
    expect(fetched?.events).toHaveLength(2);
    expect(fetched?.events.map((event) => event.author)).toEqual([
      'user_3',
      'user_4',
    ]);
  });

  it('test_list_sessions', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's2',
    });
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u2',
      sessionId: 's3',
    });

    const forUser1 = await sessionService.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(forUser1.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);

    const forApp = await sessionService.listSessions({appName: 'app1'});
    expect(forApp.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('test_delete_session', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'to_delete',
    });

    await sessionService.deleteSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'to_delete',
    });

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'to_delete',
    });
    expect(fetched).toBeUndefined();
  });

  it('test_get_user_state', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      state: {'user:theme': 'dark', 'user:locale': 'en'},
    });

    const userState = await sessionService.getUserState({
      appName: 'app1',
      userId: 'u1',
    });
    expect(userState).toEqual({theme: 'dark', locale: 'en'});
  });

  it('test_append_event_and_state_delta', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
    });

    await sessionService.appendEvent({
      session,
      event: createEvent({
        author: 'agent',
        actions: {
          stateDelta: {count: 1, 'user:score': 100, 'app:status': 'active'},
        },
      }),
    });

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: session.id,
    });

    expect(fetched).toBeDefined();
    expect(fetched?.events).toHaveLength(1);
    expect(fetched?.state['count']).toBe(1);
    expect(fetched?.state['user:score']).toBe(100);
    expect(fetched?.state['app:status']).toBe('active');
  });

  it('test_app_and_user_state_ttl', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo'},
    });

    expect(
      fakeRedis.ttlOf(redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1')),
    ).toBe(TTL_SECONDS);
    expect(fakeRedis.ttlOf(redisAppStateKey(KEY_PREFIX, 'app1'))).toBe(
      TTL_SECONDS,
    );
    expect(fakeRedis.ttlOf(redisUserStateKey(KEY_PREFIX, 'app1', 'u1'))).toBe(
      TTL_SECONDS,
    );
  });

  it('test_session_ttl_expired', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo', key1: 'val1'},
    });

    const beforeExpiry = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(beforeExpiry).toBeDefined();

    fakeRedis.advanceTime(TTL_SECONDS + 1);

    const afterExpiry = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(afterExpiry).toBeUndefined();

    const userState = await sessionService.getUserState({
      appName: 'app1',
      userId: 'u1',
    });
    expect(userState).toEqual({});

    const listed = await sessionService.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listed.sessions).toEqual([]);
  });

  it('test_session_storage_only_contains_session_state', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {
        topic: 'weather',
        'user:pref': 'dark',
        'app:env': 'prod',
        'temp:scratch': 'temp_value',
      },
    });

    expect(session.state['topic']).toBe('weather');
    expect(session.state['user:pref']).toBe('dark');
    expect(session.state['app:env']).toBe('prod');
    expect(session.state['temp:scratch']).toBe('temp_value');

    const raw = fakeRedis.rawValue(
      redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1'),
    );
    if (raw === undefined) {
      expect.fail('the session key holds no value');
    }
    const stored = JSON.parse(raw) as {state: Record<string, unknown>};
    expect(stored.state).toEqual({topic: 'weather'});
  });

  it('test_dynamic_user_and_app_state_propagation', async () => {
    const s1 = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark', s1_key: 'val1'},
    });
    const s2 = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's2',
      state: {s2_key: 'val2'},
    });

    expect(s1.state['user:theme']).toBe('dark');
    expect(s2.state['user:theme']).toBe('dark');

    await sessionService.appendEvent({
      session: s2,
      event: createEvent({
        author: 'agent',
        actions: {stateDelta: {'user:theme': 'light'}},
      }),
    });

    const reloaded = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded).toBeDefined();
    expect(reloaded?.state['user:theme']).toBe('light');
    expect(reloaded?.state['s1_key']).toBe('val1');
  });

  it('test_temp_state_not_persisted', async () => {
    const session = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'temp:code': 1234, persist_me: 'yes'},
    });
    expect(session.state['temp:code']).toBe(1234);

    const fetched = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(fetched).toBeDefined();
    expect(fetched?.state['temp:code']).toBeUndefined();
    expect(fetched?.state['persist_me']).toBe('yes');
  });

  it('test_list_sessions_state_merging', async () => {
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:lang': 'en', 'app:mode': 'fast', s1: 1},
    });
    await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's2',
      state: {s2: 2},
    });

    const listed = await sessionService.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listed.sessions).toHaveLength(2);
    for (const session of listed.sessions) {
      expect(session.state['user:lang']).toBe('en');
      expect(session.state['app:mode']).toBe('fast');
    }
  });

  it('test_cumulative_user_state_creation', async () => {
    const s1 = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:theme': 'dark', s1_key: 'val1'},
    });
    expect(s1.state['user:theme']).toBe('dark');
    expect(s1.state['user:lang']).toBeUndefined();

    const s2 = await sessionService.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's2',
      state: {'user:lang': 'en', s2_key: 'val2'},
    });
    expect(s2.state['user:theme']).toBe('dark');
    expect(s2.state['user:lang']).toBe('en');
    expect(s2.state['s2_key']).toBe('val2');
    expect(s2.state['s1_key']).toBeUndefined();

    const reloaded = await sessionService.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded).toBeDefined();
    expect(reloaded?.state['user:theme']).toBe('dark');
    expect(reloaded?.state['user:lang']).toBe('en');
    expect(reloaded?.state['s1_key']).toBe('val1');
    expect(reloaded?.state['s2_key']).toBeUndefined();

    const userState = await sessionService.getUserState({
      appName: 'app1',
      userId: 'u1',
    });
    expect(userState).toEqual({theme: 'dark', lang: 'en'});
  });
});
