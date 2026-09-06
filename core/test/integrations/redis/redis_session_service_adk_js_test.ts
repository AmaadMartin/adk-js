/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The behaviour `RedisSessionService` adds on top of the adk-python reference
 * suite: input validation, ordering, pagination, glob escaping, defensive
 * parsing, the timestamp unit on the wire, and client construction.
 *
 * The reference ports live beside this file in
 * `redis_session_service_test.ts`.
 */

import {
  createEvent,
  InputValidationError,
  RedisSessionService,
  type RedisClientLike,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  escapeRedisGlob,
  redisAppStateKey,
  redisSessionKey,
  redisUserStateKey,
} from '../../../src/integrations/redis/redis_session_service.js';
import {resetLogger, setLogger} from '../../../src/utils/logger.js';

import {FakeRedis} from './fake_redis.js';

const TTL_SECONDS = 3600;
const KEY_PREFIX = 'test:session:';

const connectMock = vi.hoisted(() => vi.fn(async () => {}));
const clientMock = vi.hoisted(() => ({
  connect: connectMock,
  on: vi.fn<(event: string, listener: (err: Error) => void) => void>(),
  get: vi.fn(async (): Promise<string | null> => null),
  set: vi.fn(async () => 'OK'),
  del: vi.fn(async () => 1),
  scanIterator: vi.fn(),
  close: vi.fn(async () => {}),
}));
const createClientMock = vi.hoisted(() => vi.fn(() => clientMock));

vi.mock('redis', () => ({createClient: createClientMock}));

/** Creates one session per id, each with a later `lastUpdateTime` than the last. */
async function seedSessions(
  service: RedisSessionService,
  ids: string[],
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: id,
    });
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 1000 + index}),
    });
  }
}

/** Builds a service backed by a fresh in-memory double. */
function serviceWith(
  client: RedisClientLike,
  ttlSeconds = TTL_SECONDS,
): RedisSessionService {
  return new RedisSessionService({keyPrefix: KEY_PREFIX, ttlSeconds, client});
}

describe('RedisSessionService input validation', () => {
  it('rejects a negative numRecentEvents before touching Redis', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const getSpy = vi.spyOn(fakeRedis, 'get');

    await expect(
      service.getSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
        config: {numRecentEvents: -1},
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('applies numRecentEvents before afterTimestamp', async () => {
    const service = serviceWith(new FakeRedis());
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    // The two filters commute while timestamps ascend, so these arrive out of
    // order: taking the recent events first drops the 500 that the timestamp
    // filter on its own would have kept.
    const appended = [
      {author: 'first', timestamp: 500},
      {author: 'second', timestamp: 100},
      {author: 'third', timestamp: 200},
    ];
    for (const event of appended) {
      await service.appendEvent({session, event: createEvent(event)});
    }

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      config: {numRecentEvents: 2, afterTimestamp: 200},
    });

    expect(fetched?.events.map((event) => event.author)).toEqual(['third']);
  });
});

describe('RedisSessionService listSessions ordering', () => {
  let service: RedisSessionService;

  beforeEach(async () => {
    service = serviceWith(new FakeRedis());
    await seedSessions(service, ['s1', 's2', 's3']);
  });

  it('orders by lastUpdateTime descending by default', async () => {
    const listed = await service.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed.sessions.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
  });

  it('orders ascending when asked', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      order: 'asc',
    });
    expect(listed.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('orders descending when asked', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      order: 'desc',
    });
    expect(listed.sessions.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
  });

  it('breaks a tie on session id ascending', async () => {
    const tied = serviceWith(new FakeRedis());
    for (const id of ['zzz', 'aaa', 'mmm']) {
      const session = await tied.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: id,
      });
      await tied.appendEvent({
        session,
        event: createEvent({author: 'user', timestamp: 500}),
      });
    }

    const listed = await tied.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed.sessions.map((s) => s.id)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

describe('RedisSessionService listSessions pagination', () => {
  let service: RedisSessionService;

  beforeEach(async () => {
    service = serviceWith(new FakeRedis());
    await seedSessions(service, ['s1', 's2', 's3', 's4', 's5']);
  });

  it('reports one page when no limit is requested', async () => {
    const listed = await service.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed).toMatchObject({
      page: 1,
      limit: 5,
      totalItems: 5,
      totalPages: 1,
    });
    expect(listed.sessions).toHaveLength(5);
  });

  it('applies an offset without a limit', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      order: 'asc',
      offset: 3,
    });
    expect(listed.sessions.map((s) => s.id)).toEqual(['s4', 's5']);
    expect(listed.totalItems).toBe(5);
  });

  it('slices by limit and offset', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      order: 'asc',
      limit: 2,
      offset: 2,
    });
    expect(listed.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(listed).toMatchObject({
      page: 2,
      limit: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });

  it('lets page take precedence over offset', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      order: 'asc',
      limit: 2,
      offset: 4,
      page: 1,
    });
    expect(listed.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(listed.page).toBe(1);
  });

  it('reports zero pages for a zero limit', async () => {
    const listed = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
      limit: 0,
    });
    expect(listed).toMatchObject({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 5,
      totalPages: 0,
    });
  });

  it('reports an empty result for an app with no sessions', async () => {
    await expect(service.listSessions({appName: 'other_app'})).resolves.toEqual(
      {
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 0,
        totalPages: 0,
      },
    );

    await expect(
      service.listSessions({appName: 'other_app', limit: 2, page: 3}),
    ).resolves.toEqual({
      sessions: [],
      page: 3,
      limit: 2,
      totalItems: 0,
      totalPages: 0,
    });
  });
});

describe('RedisSessionService defensive parsing', () => {
  let fakeRedis: FakeRedis;
  let service: RedisSessionService;

  beforeEach(async () => {
    fakeRedis = new FakeRedis();
    service = serviceWith(fakeRedis);
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'good',
    });
  });

  const envelope = {
    id: 's',
    app_name: 'app1',
    user_id: 'u1',
    state: {},
    events: [],
    last_update_time: 1,
  };

  it.each([
    ['text that is not JSON', 'not json at all'],
    ['JSON that is not a session', JSON.stringify({hello: 'world'})],
    ['a JSON array', JSON.stringify([envelope])],
    ['a non-string id', JSON.stringify({...envelope, id: 7})],
    ['a non-string app_name', JSON.stringify({...envelope, app_name: 7})],
    ['a non-string user_id', JSON.stringify({...envelope, user_id: 7})],
    [
      'a non-numeric last_update_time',
      JSON.stringify({...envelope, last_update_time: 'now'}),
    ],
    ['a non-object state', JSON.stringify({...envelope, state: 'nope'})],
    ['a non-array events', JSON.stringify({...envelope, events: 'nope'})],
    [
      'an events entry that is not an object',
      JSON.stringify({...envelope, events: [1]}),
    ],
    [
      'an event without a numeric timestamp',
      JSON.stringify({...envelope, events: [{author: 'user'}]}),
    ],
  ])('skips a scanned key holding %s', async (_label, payload) => {
    fakeRedis.seed(redisSessionKey(KEY_PREFIX, 'app1', 'u1', 'bad'), payload);

    const listed = await service.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed.sessions.map((s) => s.id)).toEqual(['good']);
  });

  it('warns and names the key it skipped', async () => {
    const warnings: string[] = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      },
      error: () => {},
    });
    const badKey = redisSessionKey(KEY_PREFIX, 'app1', 'u1', 'bad');
    try {
      fakeRedis.seed(badKey, '{');
      await service.listSessions({appName: 'app1', userId: 'u1'});
    } finally {
      resetLogger();
    }

    expect(warnings.join('\n')).toContain(badKey);
  });

  it('skips a key that expired between the scan and the read', async () => {
    const scanned = fakeRedis.scanIterator.bind(fakeRedis);
    vi.spyOn(fakeRedis, 'scanIterator').mockImplementation(
      async function* (options) {
        yield* scanned(options);
        yield [redisSessionKey(KEY_PREFIX, 'app1', 'u1', 'vanished')];
      },
    );

    const listed = await service.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed.sessions.map((s) => s.id)).toEqual(['good']);
  });

  it('resolves undefined when the session key holds a corrupt value', async () => {
    fakeRedis.seed(redisSessionKey(KEY_PREFIX, 'app1', 'u1', 'good'), '{');

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'good',
    });
    expect(fetched).toBeUndefined();
  });

  it('ignores a shared-state key that does not hold an object', async () => {
    fakeRedis.seed(redisAppStateKey(KEY_PREFIX, 'app1'), '"a string"');
    fakeRedis.seed(redisUserStateKey(KEY_PREFIX, 'app1', 'u1'), '[1, 2]');

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'good',
    });
    expect(fetched?.state).toEqual({});
    await expect(
      service.getUserState({appName: 'app1', userId: 'u1'}),
    ).resolves.toEqual({});
  });

  it('keeps a stored __proto__ key off Object.prototype', async () => {
    fakeRedis.seed(
      redisUserStateKey(KEY_PREFIX, 'app1', 'u1'),
      '{"__proto__": {"polluted": true}}',
    );

    const userState = await service.getUserState({
      appName: 'app1',
      userId: 'u1',
    });

    expect(Object.prototype.hasOwnProperty.call(userState, '__proto__')).toBe(
      true,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('escapeRedisGlob', () => {
  it('escapes every Redis glob metacharacter', () => {
    expect(escapeRedisGlob('a*b?c[d]e^f\\g')).toBe(
      'a\\*b\\?c\\[d\\]e\\^f\\\\g',
    );
  });

  it('leaves a plain segment untouched', () => {
    expect(escapeRedisGlob('app_name-1')).toBe('app_name-1');
  });

  it('keeps a wildcard user id from reaching another user', async () => {
    const service = serviceWith(new FakeRedis());
    await service.createSession({
      appName: 'app1',
      userId: 'victim',
      sessionId: 'secret',
    });

    const listed = await service.listSessions({appName: 'app1', userId: '*'});
    expect(listed.sessions).toEqual([]);
  });
});

describe('RedisSessionService storage contract', () => {
  it('builds the three documented keys', () => {
    expect(redisSessionKey('adk:session:', 'app1', 'u1', 's1')).toBe(
      'adk:session:app1:u1:s1',
    );
    expect(redisUserStateKey('adk:session:', 'app1', 'u1')).toBe(
      'adk:session:user_state:app1:u1',
    );
    expect(redisAppStateKey('adk:session:', 'app1')).toBe(
      'adk:session:app_state:app1',
    );
  });

  it('stores last_update_time in seconds and reads it back in milliseconds', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 1_770_000_000_123}),
    });

    const raw = fakeRedis.rawValue(
      redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1'),
    );
    if (raw === undefined) {
      expect.fail('the session key holds no value');
    }
    const stored = JSON.parse(raw) as {last_update_time: number};
    expect(stored.last_update_time).toBe(1_770_000_000.123);

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(fetched?.lastUpdateTime).toBe(1_770_000_000_123);
  });

  it('stores an event timestamp in seconds and reads it back in milliseconds', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 1_770_000_000_123}),
    });

    const raw = fakeRedis.rawValue(
      redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1'),
    );
    if (raw === undefined) {
      expect.fail('the session key holds no value');
    }
    const stored = JSON.parse(raw) as {events: Array<{timestamp: number}>};
    // The same unit as last_update_time in the same document: adk-python reads
    // both as POSIX seconds.
    expect(stored.events[0].timestamp).toBe(1_770_000_000.123);

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    expect(fetched?.events[0].timestamp).toBe(1_770_000_000_123);
  });

  it('reads the event clock of a session adk-python wrote', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    // An envelope in adk-python's shape: Session.model_dump_json(), with
    // Event.timestamp and last_update_time both float seconds.
    fakeRedis.seed(
      redisSessionKey(KEY_PREFIX, 'app1', 'u1', 'from_python'),
      JSON.stringify({
        id: 'from_python',
        app_name: 'app1',
        user_id: 'u1',
        state: {topic: 'weather'},
        events: [
          {
            id: 'e1',
            author: 'user',
            invocation_id: 'inv-1',
            timestamp: 1_770_000_000.5,
          },
        ],
        last_update_time: 1_770_000_000.5,
      }),
    );

    const fetched = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'from_python',
    });
    expect(fetched?.lastUpdateTime).toBe(1_770_000_000_500);
    expect(fetched?.events[0].timestamp).toBe(1_770_000_000_500);

    // The adk-js filter is millisecond-based, so a python event only survives
    // it once its clock has been converted.
    const filtered = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'from_python',
      config: {afterTimestamp: 1_770_000_000_000},
    });
    expect(filtered?.events).toHaveLength(1);
  });

  it('writes no expiry when ttlSeconds is zero', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis, 0);
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark', 'app:name': 'demo'},
    });

    expect(
      fakeRedis.ttlOf(redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1')),
    ).toBeUndefined();
    expect(
      fakeRedis.ttlOf(redisAppStateKey(KEY_PREFIX, 'app1')),
    ).toBeUndefined();

    fakeRedis.advanceTime(1_000_000);
    await expect(
      service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'}),
    ).resolves.toBeDefined();
  });

  it('leaves the shared state keys alone on delete', async () => {
    const service = serviceWith(new FakeRedis());
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark'},
    });

    await service.deleteSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.deleteSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'never_existed',
    });

    await expect(
      service.getUserState({appName: 'app1', userId: 'u1'}),
    ).resolves.toEqual({pref: 'dark'});
  });

  it('does not write shared state that no delta touched', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const appKey = redisAppStateKey(KEY_PREFIX, 'app1');

    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark'},
    });
    expect(fakeRedis.keys()).not.toContain(appKey);

    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's2',
    });
    await service.appendEvent({
      session,
      event: createEvent({author: 'agent', actions: {stateDelta: {turn: 1}}}),
    });
    expect(fakeRedis.keys()).not.toContain(appKey);
  });
});

describe('RedisSessionService appendEvent', () => {
  it('writes nothing for a partial event', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    const setSpy = vi.spyOn(fakeRedis, 'set');

    const partial = createEvent({
      author: 'agent',
      partial: true,
      actions: {stateDelta: {turn: 1}},
    });
    await expect(service.appendEvent({session, event: partial})).resolves.toBe(
      partial,
    );

    expect(setSpy).not.toHaveBeenCalled();
    expect(session.events).toEqual([]);
  });

  it('keeps app, user and temp keys out of the stored session state', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    const session = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    session.state['temp:scratch'] = 'gone';

    await service.appendEvent({
      session,
      event: createEvent({
        author: 'agent',
        actions: {stateDelta: {turn: 1, 'user:score': 9, 'app:mode': 'fast'}},
      }),
    });

    const raw = fakeRedis.rawValue(
      redisSessionKey(KEY_PREFIX, 'app1', 'u1', 's1'),
    );
    if (raw === undefined) {
      expect.fail('the session key holds no value');
    }
    const stored = JSON.parse(raw) as {state: Record<string, unknown>};
    expect(stored.state).toEqual({turn: 1});
  });

  it('reads a scan batch holding several keys', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(new BatchingRedis(fakeRedis));
    for (const id of ['s1', 's2']) {
      await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: id,
      });
    }

    const listed = await service.listSessions({appName: 'app1', userId: 'u1'});
    expect(listed.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });
});

/** A client that returns every matching key in one scan batch. */
class BatchingRedis implements RedisClientLike {
  constructor(private readonly inner: FakeRedis) {}

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  set(
    key: string,
    value: string,
    options?: {EX?: number; NX?: boolean},
  ): Promise<unknown> {
    return this.inner.set(key, value, options);
  }

  del(key: string): Promise<unknown> {
    return this.inner.del(key);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async *scanIterator(options?: {
    MATCH?: string;
    COUNT?: number;
  }): AsyncGenerator<string[]> {
    const batch: string[] = [];
    for await (const keys of this.inner.scanIterator(options)) {
      batch.push(...keys);
    }
    yield batch;
  }
}

describe('RedisSessionService client construction', () => {
  beforeEach(() => {
    createClientMock.mockClear();
    connectMock.mockClear();
    clientMock.on.mockClear();
    clientMock.close.mockClear();
  });

  it('never builds a client when one is injected', async () => {
    const service = serviceWith(new FakeRedis());
    await service.createSession({appName: 'app1', userId: 'u1'});

    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('leaves an injected client open on close', async () => {
    const fakeRedis = new FakeRedis();
    const service = serviceWith(fakeRedis);
    await service.createSession({appName: 'app1', userId: 'u1'});

    await service.close();
    expect(fakeRedis.closed).toBe(false);
  });

  it('builds a client from a URI and connects it once', async () => {
    const service = new RedisSessionService({
      uri: 'redis://:hunter2@redis.example.com:6380/2',
    });

    const [first, second] = await Promise.all([
      service.getUserState({appName: 'app1', userId: 'u1'}),
      service.getUserState({appName: 'app1', userId: 'u2'}),
    ]);

    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith({
      url: 'redis://:hunter2@redis.example.com:6380/2',
    });
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('builds a client from the discrete defaults', async () => {
    const service = new RedisSessionService();
    await service.getUserState({appName: 'app1', userId: 'u1'});

    expect(createClientMock).toHaveBeenCalledWith({
      socket: {host: 'localhost', port: 6379},
      password: undefined,
      database: 0,
    });
  });

  it('asks for TLS when ssl is set', async () => {
    const service = new RedisSessionService({
      host: 'redis.example.com',
      port: 6380,
      password: 'hunter2',
      ssl: true,
      db: 3,
    });
    await service.getUserState({appName: 'app1', userId: 'u1'});

    expect(createClientMock).toHaveBeenCalledWith({
      socket: {host: 'redis.example.com', port: 6380, tls: true},
      password: 'hunter2',
      database: 3,
    });
  });

  it('logs a redacted target when the connection errors', async () => {
    const errors: string[] = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      },
    });
    try {
      const service = new RedisSessionService({
        uri: 'redis://user:hunter2@redis.example.com:6380',
      });
      await service.getUserState({appName: 'app1', userId: 'u1'});

      const [event, listener] = clientMock.on.mock.calls[0];
      expect(event).toBe('error');
      listener(new Error('ECONNREFUSED'));
    } finally {
      resetLogger();
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('redis.example.com');
    expect(errors[0]).toContain('ECONNREFUSED');
    expect(errors[0]).not.toContain('hunter2');
  });

  it('closes a client it built, and reconnects on the next call', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379'});
    await service.getUserState({appName: 'app1', userId: 'u1'});

    await service.close();
    expect(clientMock.close).toHaveBeenCalledTimes(1);

    await service.getUserState({appName: 'app1', userId: 'u1'});
    expect(createClientMock).toHaveBeenCalledTimes(2);
  });

  it('closes nothing when it never connected', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379'});

    await service.close();
    expect(clientMock.close).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('retries after a failed connect instead of replaying the error', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const service = new RedisSessionService({uri: 'redis://localhost:6379'});

    await expect(
      service.getUserState({appName: 'app1', userId: 'u1'}),
    ).rejects.toThrow('ECONNREFUSED');
    // The failed client keeps a reconnect timer, so it is released.
    expect(clientMock.close).toHaveBeenCalledTimes(1);

    await expect(
      service.getUserState({appName: 'app1', userId: 'u1'}),
    ).resolves.toEqual({});
    expect(createClientMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the connect error even when the release fails', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    clientMock.close.mockRejectedValueOnce(new Error('already closed'));
    const service = new RedisSessionService({uri: 'redis://localhost:6379'});

    await expect(
      service.getUserState({appName: 'app1', userId: 'u1'}),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
