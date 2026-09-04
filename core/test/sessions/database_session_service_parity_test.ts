/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from `google/adk-python` `main`:
 * `src/google/adk/sessions/database_session_service.py`, exercised by
 * `tests/unittests/sessions/test_session_service.py`. The original test
 * names are kept so a reviewer can grep for them there.
 */

import {
  createEvent,
  createEventActions,
  DatabaseSessionService,
} from '@google/adk';
import {EntityManager, EntityProperty, LockMode} from '@mikro-orm/core';
import {MariaDbPlatform} from '@mikro-orm/mariadb';
import {MsSqlPlatform} from '@mikro-orm/mssql';
import {MySqlPlatform} from '@mikro-orm/mysql';
import {PostgreSqlPlatform} from '@mikro-orm/postgresql';
import {SqliteDriver, SqlitePlatform} from '@mikro-orm/sqlite';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  connectionIsAlive,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
} from '../../src/sessions/db/operations.js';
import {
  StorageAppState,
  StorageSession,
  StorageUserState,
} from '../../src/sessions/db/schema.js';
import {PreciseTimestampType} from '../../src/sessions/db/shared.js';

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

const POSTGRES_URL = 'postgresql://user:pass@localhost:5432/db';

function memoryService(): DatabaseSessionService {
  return new DatabaseSessionService({
    dbName: ':memory:',
    driver: SqliteDriver,
    allowGlobalContext: true,
  });
}

describe('DatabaseSessionService parity with adk-python', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('engine tuning', () => {
    it('test_database_session_service_enables_pool_pre_ping_by_default', async () => {
      const options = await getConnectionOptionsFromUri(POSTGRES_URL);

      expect(options.driverOptions).toEqual({
        pool: {validate: connectionIsAlive},
      });
    });

    it('test_database_session_service_respects_pool_pre_ping_override', async () => {
      const options = await getConnectionOptionsFromUri(POSTGRES_URL, {
        driverOptions: {pool: {}},
      });

      expect(options.driverOptions).toEqual({pool: {}});
    });
  });

  describe('read and write entity managers', () => {
    // adk-python asserts two session factories bound to two engines. adk-js
    // has no read-only execution option, so the ported assertion is that the
    // read path and the write path get separate units of work.
    it('test_database_session_service_creates_read_only_engine_for_other_dialects', async () => {
      const service = memoryService();
      await service.init();
      vi.clearAllMocks();

      await service.getSession({
        appName: 'my_app',
        userId: 'test_user',
        sessionId: '123',
      });
      await service.createSession({
        appName: 'my_app',
        userId: 'test_user',
        sessionId: '123',
      });

      const readEm = vi.mocked(forkForRead).mock.results[0].value;
      const writeEm = vi.mocked(forkForWrite).mock.results[0].value;
      expect(readEm).toBeDefined();
      expect(writeEm).toBeDefined();
      expect(readEm).not.toBe(writeEm);
      await service.close();
    });

    it('test_database_session_service_get_session_uses_read_only_factory', async () => {
      const service = memoryService();
      await service.init();
      vi.clearAllMocks();

      const session = await service.getSession({
        appName: 'my_app',
        userId: 'test_user',
        sessionId: '123',
      });

      expect(session).toBeUndefined();
      expect(forkForRead).toHaveBeenCalledTimes(1);
      expect(forkForWrite).not.toHaveBeenCalled();
      await service.close();
    });

    it('test_database_session_service_list_sessions_uses_read_only_factory', async () => {
      const service = memoryService();
      await service.init();
      vi.clearAllMocks();

      const response = await service.listSessions({
        appName: 'my_app',
        userId: 'test_user',
      });

      expect(response.sessions).toEqual([]);
      expect(forkForRead).toHaveBeenCalledTimes(1);
      expect(forkForWrite).not.toHaveBeenCalled();
      await service.close();
    });
  });

  describe('row-level locking', () => {
    /**
     * adk-python parametrizes this over five state deltas and asserts the
     * app-state and user-state rows are never locked without a matching
     * delta. adk-js locks a state row exactly when the event carries a delta
     * for it, so each case asserts that rule, plus the dialect gate this
     * change adds.
     */
    const stateDeltas: Array<[string, Record<string, unknown> | undefined]> = [
      ['no_state_delta', undefined],
      ['session_only_delta', {'session_key': 'v'}],
      ['app_delta_only', {'app:key': 'v'}],
      ['user_delta_only', {'user:key': 'v'}],
      ['all_scopes', {'app:a': '1', 'user:b': '2', 'sk': '3'}],
    ];

    it.each(stateDeltas)(
      'test_append_event_locks_only_scopes_with_deltas [%s]',
      async (_id, stateDelta) => {
        vi.mocked(getDatabaseBackend).mockReturnValue('postgresql');
        const service = memoryService();
        const session = await service.createSession({
          appName: 'app',
          userId: 'user',
          sessionId: 's1',
        });
        const findOne = vi.spyOn(EntityManager.prototype, 'findOne');

        try {
          await service.appendEvent({
            session,
            event: createEvent({
              invocationId: 'inv',
              author: 'user',
              actions: stateDelta
                ? createEventActions({stateDelta})
                : undefined,
            }),
          });

          const locked = new Map(
            findOne.mock.calls.map(([entityName, , options]) => [
              entityName,
              options?.lockMode,
            ]),
          );
          const lockFor = (prefix: string) =>
            Object.keys(stateDelta ?? {}).some((key) => key.startsWith(prefix))
              ? LockMode.PESSIMISTIC_WRITE
              : undefined;
          expect(locked.get(StorageSession)).toBe(LockMode.PESSIMISTIC_WRITE);
          expect(locked.get(StorageAppState)).toBe(lockFor('app:'));
          expect(locked.get(StorageUserState)).toBe(lockFor('user:'));
        } finally {
          findOne.mockRestore();
          await service.close();
        }
      },
    );
  });

  describe('engine diagnostics', () => {
    const password = 'sup3r-s3cret';

    it('test_database_session_service_engine_error_hides_password', () => {
      const url = `postgresql+asyncpg://user:${password}@localhost:5432/db`;
      let message = '';

      try {
        new DatabaseSessionService(url);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain(password);
      expect(message).toContain(
        'postgresql+asyncpg://user:***@localhost:5432/db',
      );
    });

    it('test_database_session_service_malformed_url_reports_usable_error', () => {
      let message = '';

      try {
        new DatabaseSessionService(`definitely not a url ${password}`);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain(password);
      expect(message).toContain('Invalid database URL format or argument');
    });

    // adk-python needs an async driver and tells the caller to install one.
    // adk-js selects its own driver, so the message names the bare
    // `<backend>://` form instead.
    it('test_database_session_service_sync_driver_url_names_async_driver', () => {
      let message = '';

      try {
        new DatabaseSessionService('postgresql+psycopg2://host/sessions');
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("names the 'psycopg2' driver in its scheme");
      expect(message).toContain("use a 'postgresql://' URL instead");
    });
  });
});

/**
 * Adapted. adk-python asks the service whether the active SQLAlchemy dialect
 * is naive (`_uses_naive_datetime`), then strips tzinfo before storage. A
 * JavaScript `Date` carries no tzinfo, so the only place the distinction is
 * observable in adk-js is the column adk-js declares. MikroORM gives a
 * `Platform` no dialect name, so each case drives the real platform of the
 * dialect the reference parametrizes over and pins its declaration.
 */
describe('naive datetime columns, ported from adk-python', () => {
  const preciseTimestamp = new PreciseTimestampType();
  const columnProp = {} as EntityProperty;

  /** The declaration each dialect in `_NAIVE_DATETIME_DIALECTS` must get. */
  const NAIVE_DIALECTS = {
    sqlite: {platform: new SqlitePlatform(), declaration: 'datetime'},
    postgresql: {
      platform: new PostgreSqlPlatform(),
      declaration: 'timestamp(6)',
    },
    mysql: {platform: new MySqlPlatform(), declaration: 'datetime(6)'},
    mariadb: {platform: new MariaDbPlatform(), declaration: 'datetime(6)'},
  };

  for (const [dialect, {platform, declaration}] of Object.entries(
    NAIVE_DIALECTS,
  )) {
    it(`test_database_session_service_uses_naive_datetime_for_dialect[${dialect}]`, () => {
      const columnType = preciseTimestamp.getColumnType(columnProp, platform);

      expect(columnType).toBe(declaration);
      expect(columnType).not.toContain('timestamptz');
    });
  }

  /**
   * Adapted from `test_database_session_service_keeps_timezone_for_spanner`.
   * adk-python excludes Cloud Spanner because its `TIMESTAMP` keeps a zone.
   * adk-js registers no Spanner driver (`DRIVER_LOADERS` in
   * `db/operations.ts`), so there is no Spanner platform to declare a column
   * with. This pins the other half of the rule instead: a platform that
   * already writes a zone-free declaration keeps it verbatim.
   */
  it('keeps a declaration that carries no time zone verbatim', () => {
    expect(
      preciseTimestamp.getColumnType(columnProp, new MsSqlPlatform()),
    ).toBe('datetime2(6)');
  });
});
