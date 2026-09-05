/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from google/adk-python, at `origin/main` commit `7bffb0af`:
 *
 * - `tests/unittests/sessions/test_session_service.py`
 * - `tests/unittests/sessions/_conformance.py`, which registers the `sqlite`
 *   backend with no recorded divergences, so every shared contract test in it
 *   applies here.
 *
 * Each test keeps its Python name so a reviewer can grep for it. Timestamps
 * are milliseconds on this side and POSIX seconds in the Python original, so
 * every literal instant is scaled by a thousand.
 */

import {
  AlreadyExistsError,
  createEvent,
  createEventActions,
  createSession,
  Event,
  SessionNotFoundError,
  SqliteSessionService,
  StaleSessionError,
} from '@google/adk';
import {Content, GroundingMetadata} from '@google/genai';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adk-sqlite-service-'));
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

/** The `_make_sqlite` backend of `_conformance.py`. */
function makeService(name = 'sqlite.db'): SqliteSessionService {
  return new SqliteSessionService(join(dir, name));
}

/**
 * Projects a value through JSON, dropping the `undefined`-valued fields and
 * the event signature symbol that no JSON column can carry.
 *
 * The Python original compares the reloaded event to the original directly,
 * because pydantic rebuilds a full model. `DatabaseSessionService` stores
 * events the same way this service does and loses the same two things, so a
 * reloaded event is compared against this projection instead.
 */
function throughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe('SqliteSessionService, SQLite-specific reference tests', () => {
  it('test_sqlite_session_service_accepts_sqlite_urls', async () => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      let service = new SqliteSessionService(
        'sqlite+aiosqlite:///./sessions.db',
      );
      await service.createSession({appName: 'app', userId: 'user'});
      expect(
        await new SqliteSessionService(join(dir, 'sessions.db')).listSessions({
          appName: 'app',
        }),
      ).toMatchObject({totalItems: 1});

      service = new SqliteSessionService('sqlite:///./sessions2.db');
      await service.createSession({appName: 'app', userId: 'user'});
      expect(
        await new SqliteSessionService(join(dir, 'sessions2.db')).listSessions({
          appName: 'app',
        }),
      ).toMatchObject({totalItems: 1});
    } finally {
      process.chdir(previous);
    }
  });

  it('test_sqlite_session_service_accepts_absolute_sqlite_urls', async () => {
    // SQLAlchemy spells an absolute path by leaving it whole after the empty
    // authority, so POSIX gets four slashes and Windows three plus a drive
    // letter. One template produces both.
    const absolutePath = join(dir, 'absolute.db');
    const service = new SqliteSessionService(
      `sqlite+aiosqlite:///${absolutePath}`,
    );
    await service.createSession({appName: 'app', userId: 'user'});

    const reopened = new SqliteSessionService(absolutePath);
    expect(await reopened.listSessions({appName: 'app'})).toMatchObject({
      totalItems: 1,
    });
  });

  it('test_sqlite_session_service_preserves_uri_query_parameters', async () => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      // Seed the file so the read-only open finds a database to attach to.
      await new SqliteSessionService('readonly.db').createSession({
        appName: 'app',
        userId: 'user',
      });

      const service = new SqliteSessionService(
        'sqlite+aiosqlite:///readonly.db?mode=ro',
      );
      // `mode=ro` opens the database read-only, so the write must fail.
      await expect(
        service.createSession({appName: 'app', userId: 'user2'}),
      ).rejects.toThrow(/readonly/);
    } finally {
      process.chdir(previous);
    }
  });

  it('test_sqlite_create_session_concurrent_same_id_raises_already_exists_error', async () => {
    const service = makeService('sqlite_race.db');
    const appName = 'my_app';
    const userId = 'user';

    await service.createSession({
      appName,
      userId,
      sessionId: 'warmup-session',
    });

    for (let i = 0; i < 5; i++) {
      const sessionId = `race-session-${i}`;
      const results = await Promise.allSettled([
        service.createSession({appName, userId, sessionId}),
        service.createSession({appName, userId, sessionId}),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const errors = results.filter((r) => r.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(errors).toHaveLength(1);
      const reason = errors[0].status === 'rejected' ? errors[0].reason : null;
      expect(reason).toBeInstanceOf(AlreadyExistsError);
      expect(String(reason)).toContain(sessionId);

      const finalSession = await service.getSession({
        appName,
        userId,
        sessionId,
      });
      expect(finalSession).toBeDefined();
      expect(finalSession?.id).toBe(sessionId);
    }
  });

  it('test_sqlite_append_event_uses_typed_stale_session_error', async () => {
    const service = makeService();
    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
    });
    const staleSession = structuredClone(session);

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'winner',
        author: 'user',
        timestamp: session.lastUpdateTime + 1,
      }),
    });

    await expect(
      service.appendEvent({
        session: staleSession,
        event: createEvent({
          invocationId: 'stale',
          author: 'user',
          timestamp: session.lastUpdateTime + 1,
        }),
      }),
    ).rejects.toBeInstanceOf(StaleSessionError);
  });

  // Parameterized over [DATABASE, SQLITE] in the Python original; only the
  // SQLITE half belongs here.
  it('test_append_event_with_non_serializable_state_delta', async () => {
    const service = makeService();
    const appName = 'my_app';
    const userId = 'user';

    const session = await service.createSession({appName, userId});
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        actions: createEventActions({
          stateDelta: {callback: () => 1, ok: 2},
        }),
      }),
    });

    const refreshed = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(refreshed).toBeDefined();
    expect(refreshed?.events).toHaveLength(1);
    expect(refreshed?.state['ok']).toBe(2);
    expect(typeof refreshed?.state['callback']).toBe('string');
  });

  // The Python original is parameterized over [DATABASE, SQLITE]; only the
  // SQLITE half belongs here.
  it.each([false, true])(
    'test_get_session_orders_tied_timestamps_by_id (append_ids_in_reverse=%s)',
    async (appendIdsInReverse) => {
      const appName = 'my_app';
      const userId = 'user';
      const eventIds = ['event_a', 'event_m', 'event_z'];
      const sharedTimestamp = 100000;

      const service = makeService(`ties-${appendIdsInReverse}.db`);
      const session = await service.createSession({appName, userId});
      const appendOrder = appendIdsInReverse
        ? [...eventIds].reverse()
        : eventIds;
      for (const id of appendOrder) {
        await service.appendEvent({
          session,
          event: createEvent({
            author: 'user',
            id,
            timestamp: sharedTimestamp,
          }),
        });
      }

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      expect(retrieved?.events.map((event) => event.id)).toEqual(eventIds);
    },
  );
});

describe('SqliteSessionService, shared contract tests', () => {
  let service: SqliteSessionService;

  beforeEach(() => {
    service = makeService();
  });

  it('test_get_empty_session', async () => {
    expect(
      await service.getSession({
        appName: 'my_app',
        userId: 'test_user',
        sessionId: '123',
      }),
    ).toBeUndefined();
  });

  it('test_create_get_session', async () => {
    const appName = 'my_app';
    const userId = 'test_user';
    const state = {key: 'value'};

    const session = await service.createSession({appName, userId, state});
    expect(session.appName).toBe(appName);
    expect(session.userId).toBe(userId);
    expect(session.id).toBeTruthy();
    expect(session.state).toEqual(state);
    expect(session.lastUpdateTime).toBeLessThanOrEqual(Date.now());

    const got = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(got).toEqual(session);
    expect(got?.lastUpdateTime).toBeLessThanOrEqual(Date.now());

    await service.deleteSession({appName, userId, sessionId: session.id});
    expect(
      await service.getSession({appName, userId, sessionId: session.id}),
    ).toBeUndefined();
  });

  it('test_create_and_list_sessions', async () => {
    const appName = 'my_app';
    const userId = 'test_user';
    const sessionIds = [0, 1, 2, 3, 4].map((i) => `session${i}`);

    for (const sessionId of sessionIds) {
      await service.createSession({
        appName,
        userId,
        sessionId,
        state: {key: `value${sessionId}`},
      });
    }

    const {sessions} = await service.listSessions({appName, userId});
    expect(sessions).toHaveLength(sessionIds.length);
    expect(new Set(sessions.map((s) => s.id))).toEqual(new Set(sessionIds));
    for (const session of sessions) {
      expect(session.state).toEqual({key: `value${session.id}`});
    }
  });

  it('test_list_sessions_ordered_by_last_update_time', async () => {
    const appName = 'my_app';
    const userId = 'test_user';

    for (const sessionId of ['a', 'b', 'c']) {
      await service.createSession({appName, userId, sessionId});
    }

    const sessionA = await service.getSession({
      appName,
      userId,
      sessionId: 'a',
    });
    expect(sessionA).toBeDefined();
    await service.appendEvent({
      session: sessionA!,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        timestamp: Date.now() + 10,
      }),
    });

    const {sessions} = await service.listSessions({appName, userId});
    expect(sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('test_list_sessions_all_users', async () => {
    const appName = 'my_app';

    await service.createSession({
      appName,
      userId: 'user1',
      sessionId: 'session1a',
      state: {key: 'value1a'},
    });
    await service.createSession({
      appName,
      userId: 'user1',
      sessionId: 'session1b',
      state: {key: 'value1b'},
    });
    await service.createSession({
      appName,
      userId: 'user2',
      sessionId: 'session2a',
      state: {key: 'value2a'},
    });

    const forUser1 = await service.listSessions({appName, userId: 'user1'});
    expect(forUser1.sessions).toHaveLength(2);
    const byId1 = new Map(forUser1.sessions.map((s) => [s.id, s]));
    expect(byId1.get('session1a')?.state).toEqual({key: 'value1a'});
    expect(byId1.get('session1b')?.state).toEqual({key: 'value1b'});

    const forUser2 = await service.listSessions({appName, userId: 'user2'});
    expect(forUser2.sessions).toHaveLength(1);
    expect(forUser2.sessions[0].id).toBe('session2a');
    expect(forUser2.sessions[0].state).toEqual({key: 'value2a'});

    const forAll = await service.listSessions({appName});
    expect(forAll.sessions).toHaveLength(3);
    const byIdAll = new Map(forAll.sessions.map((s) => [s.id, s]));
    expect(byIdAll.get('session1a')?.state).toEqual({key: 'value1a'});
    expect(byIdAll.get('session1b')?.state).toEqual({key: 'value1b'});
    expect(byIdAll.get('session2a')?.state).toEqual({key: 'value2a'});
  });

  it('test_app_state_is_shared_by_all_users_of_app', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {'app:k1': 'v1'},
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {'app:k2': 'v2'}}),
      }),
    });

    const session2 = await service.createSession({
      appName,
      userId: 'u2',
      sessionId: 's2',
    });
    expect(session2.state).toEqual({'app:k1': 'v1', 'app:k2': 'v2'});

    const session1Got = await service.getSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(session1Got?.state['app:k1']).toBe('v1');
    expect(session1Got?.state['app:k2']).toBe('v2');
  });

  it('test_user_state_is_shared_only_by_user_sessions', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:k1': 'v1'},
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {'user:k2': 'v2'}}),
      }),
    });

    const session1b = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1b',
    });
    expect(session1b.state).toEqual({'user:k1': 'v1', 'user:k2': 'v2'});

    const session2 = await service.createSession({
      appName,
      userId: 'u2',
      sessionId: 's2',
    });
    expect(session2.state).toEqual({});
  });

  it('test_session_state_is_not_shared', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {sk1: 'v1'},
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {sk2: 'v2'}}),
      }),
    });

    const session1Got = await service.getSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(session1Got?.state['sk1']).toBe('v1');
    expect(session1Got?.state['sk2']).toBe('v2');

    const session1b = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1b',
    });
    expect(session1b.state).toEqual({});
  });

  it('test_dict_valued_state_delta_replaces_stored_value', async () => {
    const appName = 'my_app';
    const session = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {profile: {name: 'ada', role: 'admin'}},
    });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {profile: {name: 'bob'}}}),
      }),
    });

    const reloaded = await service.getSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded?.state['profile']).toEqual({name: 'bob'});
    expect(session.state['profile']).toEqual({name: 'bob'});
  });

  it('test_none_valued_state_delta_is_stored_not_dropped', async () => {
    const appName = 'my_app';
    const session = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {flag: true},
    });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {flag: null}}),
      }),
    });

    const reloaded = await service.getSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded?.state).toHaveProperty('flag');
    expect(reloaded?.state['flag']).toBeNull();
    expect(session.state).toHaveProperty('flag');
    expect(session.state['flag']).toBeNull();
  });

  it('test_boolean_state_survives_unrelated_state_delta', async () => {
    const appName = 'my_app';
    const session = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {flag: false},
    });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {new_flag: true}}),
      }),
    });

    const reloaded = await service.getSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(reloaded?.state['new_flag']).toBe(true);
    expect(reloaded?.state['flag']).toBe(false);
    expect(session.state['new_flag']).toBe(true);
    expect(session.state['flag']).toBe(false);
  });

  it('test_app_state_dict_valued_delta_replaces_stored_value', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {'app:cfg': {name: 'ada', role: 'admin'}},
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {'app:cfg': {name: 'bob'}}}),
      }),
    });

    const session2 = await service.createSession({
      appName,
      userId: 'u2',
      sessionId: 's2',
    });
    expect(session2.state['app:cfg']).toEqual({name: 'bob'});
    expect(session1.state['app:cfg']).toEqual({name: 'bob'});
  });

  it('test_user_state_none_valued_delta_is_stored_not_dropped', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
      state: {'user:pref': 'dark_mode'},
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({
        invocationId: 'inv1',
        author: 'user',
        actions: createEventActions({stateDelta: {'user:pref': null}}),
      }),
    });

    const session1b = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1b',
    });
    expect(session1b.state).toHaveProperty('user:pref');
    expect(session1b.state['user:pref']).toBeNull();
    expect(session1.state).toHaveProperty('user:pref');
    expect(session1.state['user:pref']).toBeNull();
  });

  it('test_temp_state_is_not_persisted_in_state_or_events', async () => {
    const appName = 'my_app';
    const session = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    const event = createEvent({
      invocationId: 'inv1',
      author: 'user',
      actions: createEventActions({
        stateDelta: {'temp:k1': 'v1', sk: 'v2'},
      }),
    });
    await service.appendEvent({session, event});

    expect(session.state['temp:k1']).toBe('v1');
    expect(session.state['sk']).toBe('v2');

    expect(event.actions.stateDelta).not.toHaveProperty('temp:k1');
    expect(event.actions.stateDelta?.['sk']).toBe('v2');
  });

  it('test_temp_state_visible_across_sequential_events', async () => {
    const appName = 'my_app';
    const session = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's_seq',
    });

    const event1 = createEvent({
      invocationId: 'inv1',
      author: 'agent1',
      actions: createEventActions({
        stateDelta: {'temp:output': 'result_from_a1'},
      }),
    });
    await service.appendEvent({session, event: event1});

    expect(session.state['temp:output']).toBe('result_from_a1');
    expect(event1.actions.stateDelta).not.toHaveProperty('temp:output');
  });

  it('test_get_session_respects_user_id', async () => {
    const appName = 'my_app';
    const session1 = await service.createSession({
      appName,
      userId: 'u1',
      sessionId: 's1',
    });
    await service.appendEvent({
      session: session1,
      event: createEvent({invocationId: 'inv1', author: 'user'}),
    });
    await service.createSession({appName, userId: 'u2', sessionId: 's1'});

    const session2Got = await service.getSession({
      appName,
      userId: 'u2',
      sessionId: 's1',
    });
    expect(session2Got?.userId).toBe('u2');
    expect(session2Got?.events).toHaveLength(0);
  });

  it('test_create_session_with_existing_id_raises_error', async () => {
    const appName = 'my_app';
    const userId = 'test_user';
    const sessionId = 'existing_session';

    await service.createSession({appName, userId, sessionId});

    await expect(
      service.createSession({appName, userId, sessionId}),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it('test_append_event_bytes', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const session = await service.createSession({appName, userId});

    const content: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            data: Buffer.from('test_image_data').toString('base64'),
            mimeType: 'image/png',
          },
        },
      ],
    };
    const groundingMetadata: GroundingMetadata = {
      searchEntryPoint: {
        sdkBlob: Buffer.from('test_sdk_blob').toString('base64'),
      },
    };
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        content,
        groundingMetadata,
      }),
    });

    expect(session.events[0].content).toEqual(content);

    const reloaded = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(reloaded?.events).toHaveLength(1);
    expect(reloaded?.events[0].content).toEqual(content);
    expect(reloaded?.events[0].groundingMetadata).toEqual(groundingMetadata);
  });

  it('test_append_event_complete', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const session = await service.createSession({appName, userId});

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        content: {role: 'user', parts: [{text: 'test_text'}]},
        turnComplete: true,
        partial: false,
        actions: createEventActions({
          artifactDelta: {file: 0},
          transferToAgent: 'agent',
          escalate: true,
        }),
        longRunningToolIds: ['tool1'],
        errorCode: 'error_code',
        errorMessage: 'error_message',
        interrupted: true,
        groundingMetadata: {webSearchQueries: ['query1']},
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
        citationMetadata: {},
        customMetadata: {custom_key: 'custom_value'},
        timestamp: 1700000000123,
        inputTranscription: {text: 'input transcription', finished: true},
        outputTranscription: {text: 'output transcription', finished: true},
      }),
    });

    const reloaded = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(reloaded?.events).toEqual(throughJson(session.events));
    expect(reloaded?.state).toEqual(session.state);
    expect(reloaded?.lastUpdateTime).toBe(session.lastUpdateTime);
  });

  it('test_append_event_with_requested_tool_confirmations', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const session = await service.createSession({appName, userId});

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        actions: createEventActions({
          requestedToolConfirmations: {
            tool_call_1: {
              hint: 'dynamic hint',
              confirmed: false,
              payload: {collection_name: 'photos', resource_id: 'album_1'},
            },
          },
        }),
      }),
    });

    const refreshed = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(refreshed).toBeDefined();
    expect(refreshed?.events).toHaveLength(1);
    const confirmations =
      refreshed?.events[0].actions.requestedToolConfirmations;
    expect(confirmations).toHaveProperty('tool_call_1');
    const confirmation = confirmations?.['tool_call_1'];
    expect(confirmation?.hint).toBe('dynamic hint');
    expect(confirmation?.payload).toEqual({
      collection_name: 'photos',
      resource_id: 'album_1',
    });
    expect(confirmation?.confirmed).toBe(false);
  });

  it('test_session_last_update_time_updates_on_event', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const session = await service.createSession({appName, userId});
    const originalUpdateTime = session.lastUpdateTime;

    const eventTimestamp = originalUpdateTime + 10000;
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation',
        author: 'user',
        timestamp: eventTimestamp,
      }),
    });

    expect(session.lastUpdateTime).toBe(eventTimestamp);

    const refreshed = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(refreshed).toBeDefined();
    expect(refreshed?.lastUpdateTime).toBe(eventTimestamp);
    expect(refreshed?.lastUpdateTime).toBeGreaterThan(originalUpdateTime);
  });

  it('test_append_event_to_unknown_session_raises_session_not_found', async () => {
    const session = createSession({
      appName: 'my_app',
      userId: 'user',
      id: 'never_created',
    });

    await expect(
      service.appendEvent({
        session,
        event: createEvent({invocationId: 'inv1', author: 'user'}),
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('test_get_session_with_config', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const numTestEvents = 5;
    const baseTimestamp = Math.trunc(Date.now() / 1000) * 1000;

    const created = await service.createSession({appName, userId});
    for (let i = 1; i <= numTestEvents; i++) {
      await service.appendEvent({
        session: created,
        event: createEvent({
          author: 'user',
          timestamp: baseTimestamp + i * 1000,
        }),
      });
    }
    const sessionId = created.id;

    const all = await service.getSession({appName, userId, sessionId});
    expect(all?.events).toHaveLength(numTestEvents);

    const none = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {numRecentEvents: 0},
    });
    expect(none?.events).toHaveLength(0);

    const numRecentEvents = 3;
    const recent = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {numRecentEvents},
    });
    expect(recent?.events).toHaveLength(numRecentEvents);
    expect(recent?.events[0].timestamp).toBe(
      baseTimestamp + (numTestEvents - numRecentEvents + 1) * 1000,
    );

    const afterEventIndex = 4;
    const afterTimestamp = baseTimestamp + afterEventIndex * 1000;
    const after = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {afterTimestamp},
    });
    expect(after?.events).toHaveLength(numTestEvents - afterEventIndex + 1);
    expect(after?.events[0].timestamp).toBe(afterTimestamp);

    const wayAfter = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {afterTimestamp: baseTimestamp + numTestEvents * 10000},
    });
    expect(wayAfter?.events).toHaveLength(0);

    const both = await service.getSession({
      appName,
      userId,
      sessionId,
      config: {afterTimestamp, numRecentEvents},
    });
    expect(both?.events).toHaveLength(numTestEvents - afterEventIndex + 1);
  });

  it('test_partial_events_are_not_persisted', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const session = await service.createSession({appName, userId});

    await service.appendEvent({
      session,
      event: createEvent({author: 'user', partial: true}),
    });

    expect(session.events).toHaveLength(0);
    const got = await service.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(got?.events).toHaveLength(0);
  });

  it('test_get_user_state_returns_empty_dict_when_no_state_exists', async () => {
    expect(
      await service.getUserState({appName: 'my_app', userId: 'u1'}),
    ).toEqual({});
  });

  it('test_get_user_state_returns_state_written_via_append_event', async () => {
    const session = await service.createSession({
      appName: 'my_app',
      userId: 'u1',
    });
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'system',
        actions: createEventActions({
          stateDelta: {'user:profile': {name: 'Alice'}, session_key: 1},
        }),
      }),
    });

    const state = await service.getUserState({
      appName: 'my_app',
      userId: 'u1',
    });
    expect(state).toEqual({profile: {name: 'Alice'}});
    expect(state).not.toHaveProperty('session_key');
  });

  it('test_get_user_state_is_not_visible_across_users', async () => {
    const session = await service.createSession({
      appName: 'my_app',
      userId: 'u1',
    });
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'system',
        actions: createEventActions({
          stateDelta: {'user:secret': 'only-for-u1'},
        }),
      }),
    });

    expect(
      await service.getUserState({appName: 'my_app', userId: 'u2'}),
    ).toEqual({});
  });

  it('test_get_user_state_is_not_visible_across_apps', async () => {
    const session = await service.createSession({
      appName: 'my_app',
      userId: 'u1',
    });
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'system',
        actions: createEventActions({
          stateDelta: {'user:data': 'only-app-a'},
        }),
      }),
    });

    expect(
      await service.getUserState({appName: 'other_app', userId: 'u1'}),
    ).toEqual({});
  });

  it('test_get_user_state_available_before_session_is_created', async () => {
    const firstSession = await service.createSession({
      appName: 'my_app',
      userId: 'u1',
    });
    await service.appendEvent({
      session: firstSession,
      event: createEvent({
        author: 'system',
        actions: createEventActions({stateDelta: {'user:ctx': {v: 1}}}),
      }),
    });

    expect(
      await service.getUserState({appName: 'my_app', userId: 'u1'}),
    ).toEqual({ctx: {v: 1}});
  });

  it('test_get_user_state_reflects_latest_write', async () => {
    const session = await service.createSession({
      appName: 'my_app',
      userId: 'u1',
    });
    for (const counter of [1, 2]) {
      await service.appendEvent({
        session,
        event: createEvent({
          author: 'system',
          actions: createEventActions({stateDelta: {'user:counter': counter}}),
          timestamp: Date.now() + counter,
        }),
      });
    }

    const state = await service.getUserState({
      appName: 'my_app',
      userId: 'u1',
    });
    expect(state['counter']).toBe(2);
  });

  it('test_get_session_keeps_exact_epoch_across_a_repeated_local_hour', async () => {
    // 2024-11-03 06:00 and 06:30 UTC are 01:00 and 01:30 in US Eastern for
    // the second time that morning, so their local wall-clock times are
    // ambiguous. A round trip that rebuilds the epoch from local time alone
    // returns them an hour early.
    const repeatedHourEpochs = [1730613600000, 1730615400000];
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/New_York';

    try {
      const appName = 'my_app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      for (const timestamp of repeatedHourEpochs) {
        await service.appendEvent({
          session,
          event: createEvent({author: 'user', timestamp}),
        });
      }

      const retrieved = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });
      expect(retrieved?.events.map((event: Event) => event.timestamp)).toEqual(
        repeatedHourEpochs,
      );
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });
});
