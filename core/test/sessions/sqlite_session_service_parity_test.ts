/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from `google/adk-python` `main`:
 * `src/google/adk/sessions/sqlite_session_service.py`, exercised by
 * `tests/unittests/sessions/test_session_service.py`. The original test names
 * are kept so a reviewer can grep for them there.
 *
 * These run against real SQLite files rather than `:memory:`, because that is
 * the only way the URL grammar, the query string and the foreign-key pragma
 * are exercised at all.
 */

import {createEvent, DatabaseSessionService} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ENTITIES} from '../../src/sessions/db/schema.js';

describe('SqliteSessionService parity', () => {
  let tempDir: string;
  const openServices: DatabaseSessionService[] = [];

  /** Opens a service and registers it for teardown. */
  function open(uri: string): DatabaseSessionService {
    const service = new DatabaseSessionService(uri);
    openServices.push(service);
    return service;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'adk-sqlite-parity-'));
  });

  afterEach(async () => {
    for (const service of openServices.splice(0)) {
      await service.close();
    }
    rmSync(tempDir, {recursive: true, force: true});
  });

  it('test_sqlite_session_service_accepts_sqlite_urls', async () => {
    // Divergence from adk-python: adk-js reads everything after `sqlite://`
    // as the path, verbatim, rather than following SQLAlchemy's rule that
    // `sqlite:///x.db` is relative. Changing that would relocate every
    // existing user's database, so the reference URLs are rewritten here.
    const dbPath = join(tempDir, 'sessions.db');
    const service = open(`sqlite://${dbPath}`);

    await service.createSession({appName: 'app', userId: 'user'});

    expect(existsSync(dbPath)).toBe(true);
  });

  it('test_sqlite_session_service_accepts_absolute_sqlite_urls', async () => {
    const absDbPath = join(tempDir, 'absolute.db');
    expect(isAbsolute(absDbPath)).toBe(true);
    const service = open(`sqlite://${absDbPath}`);

    await service.createSession({appName: 'app', userId: 'user'});

    expect(existsSync(absDbPath)).toBe(true);
  });

  it('test_sqlite_session_service_preserves_uri_query_parameters', async () => {
    const dbPath = join(tempDir, 'readonly.db');
    const writer = open(`sqlite://${dbPath}`);
    await writer.createSession({appName: 'app', userId: 'user'});

    const readOnly = open(`sqlite://${dbPath}?mode=ro`);

    await expect(
      readOnly.createSession({appName: 'app', userId: 'user'}),
    ).rejects.toThrow(/readonly/);
  });

  it('surfaces the SQLite error for an unusable query parameter', async () => {
    const service = open(`sqlite://${join(tempDir, 'bad.db')}?mode=bogus`);

    await expect(
      service.createSession({appName: 'app', userId: 'user'}),
    ).rejects.toThrow(/no such access mode: bogus/);
  });

  it('test_sqlite_create_session_concurrent_same_id_raises_already_exists_error', async () => {
    // Divergence from adk-python: `main` reports a duplicate session id with a
    // bare `Error`, not `AlreadyExistsError`. The typed error is a separate
    // change, so this pins what `main` does today.
    const service = open(`sqlite://${join(tempDir, 'sqlite_race.db')}`);
    await service.createSession({
      appName: 'my_app',
      userId: 'user',
      sessionId: 'warmup-session',
    });

    const sessionId = 'race-session-0';
    const results = await Promise.allSettled([
      service.createSession({appName: 'my_app', userId: 'user', sessionId}),
      service.createSession({appName: 'my_app', userId: 'user', sessionId}),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain(sessionId);

    const stored = await service.getSession({
      appName: 'my_app',
      userId: 'user',
      sessionId,
    });
    expect(stored?.id).toBe(sessionId);
  });

  it('deletes a session and its events together', async () => {
    const service = open(`sqlite://${join(tempDir, 'cascade.db')}`);
    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'to-delete',
    });
    await service.appendEvent({
      session,
      event: createEvent({id: 'e1', invocationId: 'i1', timestamp: 1}),
    });

    await service.deleteSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'to-delete',
    });

    const reopened = open(`sqlite://${join(tempDir, 'cascade.db')}`);
    const gone = await reopened.getSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'to-delete',
    });
    expect(gone).toBeUndefined();
    const recreated = await reopened.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'to-delete',
    });
    expect(recreated.events).toEqual([]);
  });

  describe('_decode_state', () => {
    /**
     * Overwrites a state column with text no adk-js writer produces, which is
     * what another tool or a hand-edit leaves behind.
     */
    async function writeRawState(
      dbPath: string,
      table: string,
      value: string,
    ): Promise<void> {
      const orm = await MikroORM.init({
        dbName: dbPath,
        driver: SqliteDriver,
        entities: ENTITIES,
      });
      await orm.em
        .getConnection()
        .execute(`UPDATE ${table} SET state = ?`, [value]);
      await orm.close();
    }

    it.each([
      ['sessions', 'session state'],
      ['app_states', 'app state'],
      ['user_states', 'user state'],
    ])(
      'rejects a %s column holding JSON that is not an object',
      async (table, context) => {
        const dbPath = join(tempDir, `${table}-not-an-object.db`);
        const writer = open(`sqlite://${dbPath}`);
        await writer.createSession({
          appName: 'app',
          userId: 'user',
          sessionId: 's',
        });
        await writeRawState(dbPath, table, '[1,2,3]');

        const reader = open(`sqlite://${dbPath}`);
        await expect(
          reader.getSession({appName: 'app', userId: 'user', sessionId: 's'}),
        ).rejects.toThrow(`Persisted ${context} must be a JSON object.`);
      },
    );

    it('names the column when its JSON does not parse', async () => {
      const dbPath = join(tempDir, 'invalid-json.db');
      const writer = open(`sqlite://${dbPath}`);
      await writer.createSession({
        appName: 'app',
        userId: 'user',
        sessionId: 's',
      });
      await writeRawState(dbPath, 'sessions', '{oops');

      const reader = open(`sqlite://${dbPath}`);
      await expect(
        reader.getSession({appName: 'app', userId: 'user', sessionId: 's'}),
      ).rejects.toThrow(/^Invalid JSON in session state: /);
    });
  });

  it('reloads a session and its events from the file after a restart', async () => {
    const dbPath = join(tempDir, 'restart.db');
    const first = open(`sqlite://${dbPath}`);
    const session = await first.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'kept',
      state: {turns: 1},
    });
    await first.appendEvent({
      session,
      event: createEvent({id: 'e1', invocationId: 'i1', timestamp: 1}),
    });

    const restarted = open(`sqlite://${dbPath}`);
    const reloaded = await restarted.getSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'kept',
    });

    expect(reloaded?.state['turns']).toBe(1);
    expect(reloaded?.events.map((e) => e.id)).toEqual(['e1']);
  });
});
