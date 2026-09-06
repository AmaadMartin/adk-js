/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests with no counterpart in adk-python. They pin the things a behavioural
 * test cannot see: the bytes on disk, the foreign key cascade, and the
 * failures a TypeScript caller can provoke.
 */

import {
  createEvent,
  createEventActions,
  SqliteSessionService,
} from '@google/adk';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sqlite3 from 'sqlite3';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SQLITE3_PEER} from '../../src/sessions/sqlite_connection.js';
import {decodeState} from '../../src/sessions/sqlite_session_service.js';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adk-sqlite-adkjs-'));
});

afterEach(() => {
  vi.resetModules();
  rmSync(dir, {recursive: true, force: true});
});

/** Reads rows with a bare driver handle, bypassing the service entirely. */
function queryRaw<T>(dbPath: string, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.all<T>(sql, (queryError, rows) => {
        db.close(() => {
          if (queryError) {
            reject(queryError);
            return;
          }
          resolve(rows);
        });
      });
    });
  });
}

describe('decodeState', () => {
  it('decodes an object into a null-prototype map', () => {
    const state = decodeState('{"a":1,"b":null}');
    expect(state).toEqual({a: 1, b: null});
    expect(Object.getPrototypeOf(state)).toBeNull();
  });

  it('rejects malformed JSON, naming the column', () => {
    expect(() => decodeState('{oops', 'session state')).toThrow(
      /^Invalid JSON in session state: /,
    );
    expect(() => decodeState('{oops')).toThrow(
      /^Invalid JSON in persisted state: /,
    );
  });

  it('rejects JSON that is not an object', () => {
    for (const value of ['[1,2,3]', 'null', '7', '"text"']) {
      expect(() => decodeState(value)).toThrow(
        'Persisted session state must be a JSON object.',
      );
    }
  });

  it('surfaces a corrupted state column through getSession', async () => {
    const dbPath = join(dir, 'corrupt.db');
    const service = new SqliteSessionService(dbPath);
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });

    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, (openError) => {
        if (openError) {
          reject(openError);
          return;
        }
        db.exec("UPDATE sessions SET state='[1,2,3]'", (execError) => {
          db.close(() => (execError ? reject(execError) : resolve()));
        });
      });
    });

    await expect(
      service.getSession({
        appName: 'app',
        userId: 'u',
        sessionId: session.id,
      }),
    ).rejects.toThrow('Persisted session state must be a JSON object.');
  });
});

describe('SqliteSessionService file layout', () => {
  it('writes POSIX seconds, not milliseconds, into every epoch column', async () => {
    const dbPath = join(dir, 'epochs.db');
    const service = new SqliteSessionService(dbPath);
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    await service.appendEvent({
      session,
      event: createEvent({invocationId: 'inv-1', author: 'user'}),
    });

    const nowSeconds = Date.now() / 1000;
    const [sessionRow] = await queryRaw<{
      create_time: number;
      update_time: number;
    }>(dbPath, 'SELECT create_time, update_time FROM sessions');
    const [eventRow] = await queryRaw<{timestamp: number}>(
      dbPath,
      'SELECT timestamp FROM events',
    );

    // A millisecond value would be a thousand times too large.
    expect(sessionRow.create_time).toBeCloseTo(nowSeconds, -1);
    expect(sessionRow.update_time).toBeCloseTo(nowSeconds, -1);
    expect(eventRow.timestamp).toBeCloseTo(nowSeconds, -1);
  });

  it('writes event_data as snake_case JSON adk-python can read', async () => {
    const dbPath = join(dir, 'snake.db');
    const service = new SqliteSessionService(dbPath);
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hi'}]},
      }),
    });

    const [row] = await queryRaw<{event_data: string}>(
      dbPath,
      'SELECT event_data FROM events',
    );
    const stored = JSON.parse(row.event_data);
    expect(stored).toHaveProperty('invocation_id', 'inv-1');
    expect(stored).not.toHaveProperty('invocationId');
  });

  it('stores state columns as JSON text', async () => {
    const dbPath = join(dir, 'state-text.db');
    await new SqliteSessionService(dbPath).createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      state: {'app:a': 1, 'user:b': 2, c: 3},
    });

    const [session] = await queryRaw<{state: string}>(
      dbPath,
      'SELECT state FROM sessions',
    );
    const [app] = await queryRaw<{state: string}>(
      dbPath,
      'SELECT state FROM app_states',
    );
    const [user] = await queryRaw<{state: string}>(
      dbPath,
      'SELECT state FROM user_states',
    );
    expect(JSON.parse(session.state)).toEqual({c: 3});
    expect(JSON.parse(app.state)).toEqual({a: 1});
    expect(JSON.parse(user.state)).toEqual({b: 2});
  });

  it('deletes a session events through the foreign key cascade', async () => {
    const dbPath = join(dir, 'cascade.db');
    const service = new SqliteSessionService(dbPath);
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    for (const invocationId of ['inv-1', 'inv-2']) {
      await service.appendEvent({
        session,
        event: createEvent({invocationId, author: 'user'}),
      });
    }

    expect(
      await queryRaw<{n: number}>(dbPath, 'SELECT COUNT(*) AS n FROM events'),
    ).toEqual([{n: 2}]);

    await service.deleteSession({appName: 'app', userId: 'u', sessionId: 's'});

    expect(
      await queryRaw<{n: number}>(dbPath, 'SELECT COUNT(*) AS n FROM events'),
    ).toEqual([{n: 0}]);
  });

  it('leaves another session events alone when one is deleted', async () => {
    const dbPath = join(dir, 'cascade-scope.db');
    const service = new SqliteSessionService(dbPath);
    for (const sessionId of ['keep', 'drop']) {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId,
      });
      await service.appendEvent({
        session,
        event: createEvent({invocationId: sessionId, author: 'user'}),
      });
    }

    await service.deleteSession({
      appName: 'app',
      userId: 'u',
      sessionId: 'drop',
    });

    expect(
      await queryRaw<{session_id: string}>(
        dbPath,
        'SELECT session_id FROM events',
      ),
    ).toEqual([{session_id: 'keep'}]);
  });
});

describe('SqliteSessionService listSessions state merge', () => {
  /** Gives two users of one app an app-scoped and a user-scoped value each. */
  async function seedTwoUsers(dbPath: string): Promise<SqliteSessionService> {
    const service = new SqliteSessionService(dbPath);
    await service.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
      state: {'app:shared': 'a', 'user:pref': 'one', own: 1},
    });
    await service.createSession({
      appName: 'app',
      userId: 'u2',
      sessionId: 's2',
      state: {'user:pref': 'two', own: 2},
    });
    return service;
  }

  it('merges one user state when a user id is given', async () => {
    const service = await seedTwoUsers(join(dir, 'list-one-user.db'));

    const {sessions} = await service.listSessions({
      appName: 'app',
      userId: 'u1',
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].state).toEqual({
      'app:shared': 'a',
      'user:pref': 'one',
      own: 1,
    });
  });

  it('merges each user own state when no user id is given', async () => {
    const service = await seedTwoUsers(join(dir, 'list-all-users.db'));

    const {sessions} = await service.listSessions({appName: 'app'});
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get('s1')?.state).toEqual({
      'app:shared': 'a',
      'user:pref': 'one',
      own: 1,
    });
    // u2 must see the shared app value but only its own user value.
    expect(byId.get('s2')?.state).toEqual({
      'app:shared': 'a',
      'user:pref': 'two',
      own: 2,
    });
  });

  it('reports an empty result set as zero pages', async () => {
    const service = new SqliteSessionService(join(dir, 'list-empty.db'));
    expect(await service.listSessions({appName: 'app'})).toEqual({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 0,
      totalPages: 0,
    });
  });
});

describe('SqliteSessionService state merge', () => {
  it('stores a null-valued delta rather than deleting the key', async () => {
    // `json_patch` would read the null as "delete this key"; the merge SQL
    // uses `json_group_object` over `json_each` so the null is stored.
    const service = new SqliteSessionService(join(dir, 'null-merge.db'));
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      state: {'app:cfg': 'v', 'user:pref': 'v', keep: 'v', drop: 'v'},
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({
          stateDelta: {drop: null, 'app:cfg': null, 'user:pref': null},
        }),
      }),
    });

    const reloaded = await service.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    expect(reloaded?.state).toEqual({
      keep: 'v',
      drop: null,
      'app:cfg': null,
      'user:pref': null,
    });
  });

  it('replaces an object value instead of deep-merging it', async () => {
    const service = new SqliteSessionService(join(dir, 'replace.db'));
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      state: {cfg: {a: 1, b: 2}},
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({stateDelta: {cfg: {a: 9}}}),
      }),
    });

    const reloaded = await service.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    expect(reloaded?.state['cfg']).toEqual({a: 9});
  });

  it('keeps the JSON type of every stored value across a merge', async () => {
    const service = new SqliteSessionService(join(dir, 'types.db'));
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      state: {
        flag: true,
        off: false,
        count: 7,
        text: 'v',
        list: [1, 'two'],
        obj: {k: 'v'},
        nothing: null,
      },
    });

    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({stateDelta: {unrelated: 1}}),
      }),
    });

    const reloaded = await service.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    expect(reloaded?.state).toEqual({
      flag: true,
      off: false,
      count: 7,
      text: 'v',
      list: [1, 'two'],
      obj: {k: 'v'},
      nothing: null,
      unrelated: 1,
    });
  });

  it('does not re-parent a state map through a __proto__ key', async () => {
    const service = new SqliteSessionService(join(dir, 'proto.db'));
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      // `JSON.parse` makes `__proto__` an own key, so a request body can carry
      // one.
      state: JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'),
    });

    expect(session.state['ok']).toBe(1);
    expect('polluted' in {}).toBe(false);

    const reloaded = await service.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    expect(reloaded?.state['ok']).toBe(1);
    expect('polluted' in {}).toBe(false);
  });

  it('coerces a value no JSON column can hold, keeping the rest', async () => {
    const service = new SqliteSessionService(join(dir, 'coerce.db'));
    const session = await service.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      state: {big: 10n, ok: 'v'},
    });

    expect(session.state['big']).toBe('10');
    expect(session.state['ok']).toBe('v');

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({stateDelta: {'user:cycle': cyclic}}),
      }),
    });

    expect(await service.getUserState({appName: 'app', userId: 'u'})).toEqual({
      cycle: '[object Object]',
    });
  });
});

describe('loading the sqlite3 driver', () => {
  it('names the feature and the install command when it is absent', async () => {
    // Vitest cannot make a real `import()` fail with a module-not-found code,
    // so the peer the service registers is driven through the loader here.
    const missing = Object.assign(
      new Error("Cannot find package 'sqlite3' imported from /app/index.js"),
      {code: 'ERR_MODULE_NOT_FOUND'},
    );

    await expect(
      loadOptionalPeer(SQLITE3_PEER, () => {
        throw missing;
      }),
    ).rejects.toThrow(
      /SqliteSessionService requires the optional peer dependency "sqlite3"/,
    );
    await expect(
      loadOptionalPeer(SQLITE3_PEER, () => {
        throw missing;
      }),
    ).rejects.toThrow(/npm install sqlite3/);
  });

  it('surfaces an unrelated load failure unchanged', async () => {
    // A module that fails to evaluate is not a missing package, and must not
    // be reported as one.
    vi.doMock('sqlite3', () => {
      throw new Error('boom while evaluating the driver');
    });
    vi.resetModules();

    const {SqliteSessionService: Reloaded} =
      await import('../../src/sessions/sqlite_session_service.js');
    const service = new Reloaded(join(dir, 'broken-driver.db'));

    await expect(
      service.createSession({appName: 'app', userId: 'u'}),
    ).rejects.not.toThrow(/requires the optional peer dependency/);
    vi.doUnmock('sqlite3');
  });
});
