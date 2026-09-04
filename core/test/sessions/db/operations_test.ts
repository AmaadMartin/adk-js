/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {setLogger} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  assertSupportedDatabaseUri,
  connectionIsAlive,
  detectDatabaseSchemaVersion,
  dialectOf,
  enableSqliteForeignKeys,
  ensureDatabaseCreated,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  getOrCreateRow,
  namesSupportedDatabaseBackend,
  openDatabaseOrm,
  parseSqliteUri,
  schemeOf,
  supportsRowLevelLocking,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/operations.js';
import {
  ENTITIES,
  EVENTS_TABLE_NAME,
  METADATA_TABLE_NAME,
  SCHEMA_VERSION_0_PICKLE,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageAppState,
  StorageEvent,
  StorageMetadata,
  StorageSession,
  StorageUserState,
} from '../../../src/sessions/db/schema.js';
import {ENTITIES_V0} from '../../../src/sessions/db/schema_v0.js';
import {PreciseTimestampType} from '../../../src/sessions/db/shared.js';
import {resetLogger} from '../../../src/utils/logger.js';

// Mock dynamic imports for drivers that might not be installed in dev
vi.mock('@mikro-orm/postgresql', () => ({
  PostgreSqlDriver: class MockPostgreSqlDriver {},
}));
vi.mock('@mikro-orm/mysql', () => ({
  MySqlDriver: class MockMySqlDriver {},
}));
vi.mock('@mikro-orm/mariadb', () => ({
  MariaDbDriver: class MockMariaDbDriver {},
}));
vi.mock('@mikro-orm/mssql', () => ({
  MsSqlDriver: class MockMsSqlDriver {},
}));

describe('operations', () => {
  describe('storage schema', () => {
    let orm: MikroORM;

    afterEach(async () => {
      if (orm) {
        await orm.close();
      }
    });

    it('keeps events composite key columns within the MySQL index limit', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });

      const eventProperties = orm.getMetadata().get(StorageEvent.name)
        .properties as Record<string, {length?: number}>;
      const keyProperties = ['id', 'appName', 'userId', 'sessionId'];

      for (const keyProperty of keyProperties) {
        expect(eventProperties[keyProperty].length).toBe(
          STORAGE_KEY_COLUMN_LENGTH,
        );
      }

      const utf8mb4KeyBytes = keyProperties.reduce((total, keyProperty) => {
        return total + eventProperties[keyProperty].length! * 4;
      }, 0);
      expect(utf8mb4KeyBytes).toBeLessThanOrEqual(3072);
    });

    it('declares millisecond precision on every timestamp column', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });

      // MySQL and MariaDB emit `datetime` with no fractional digits unless
      // something declares them, and the whole-second value that column holds
      // would round away the millisecond the revision marker and the event
      // ordering both compare. `PreciseTimestampType` declares the digits per
      // backend, so every timestamp column has to be bound to it.
      const timestampColumns: Array<[string, string]> = [
        [StorageSession.name, 'createTime'],
        [StorageSession.name, 'updateTime'],
        [StorageAppState.name, 'updateTime'],
        [StorageUserState.name, 'updateTime'],
        [StorageEvent.name, 'timestamp'],
      ];

      for (const [entity, property] of timestampColumns) {
        const properties = orm.getMetadata().get(entity).properties as Record<
          string,
          {customType?: unknown}
        >;
        expect(properties[property].customType).toBeInstanceOf(
          PreciseTimestampType,
        );
      }
    });

    describe('state column decoding', () => {
      /**
       * The state type bound to `StorageSession.state`. A backend whose driver
       * decodes a json column itself — Postgres, MySQL — hands this an object
       * rather than text, and only sqlite is installed here, so the branch is
       * driven through the bound type directly.
       */
      async function bindStateType() {
        orm = await MikroORM.init({
          dbName: ':memory:',
          driver: SqliteDriver,
          entities: ENTITIES,
        });
        const stateType = orm.getMetadata().get(StorageSession.name).properties[
          'state'
        ].customType;
        if (!stateType) {
          expect.fail('StorageSession.state has no state type bound');
        }
        return {stateType, platform: orm.em.getPlatform()};
      }

      it('accepts an object the driver already decoded', async () => {
        const {stateType, platform} = await bindStateType();

        expect(stateType.convertToJSValue({turns: 2}, platform)).toEqual({
          turns: 2,
        });
      });

      it('rejects a decoded value that is not an object', async () => {
        const {stateType, platform} = await bindStateType();

        expect(() => stateType.convertToJSValue([1, 2, 3], platform)).toThrow(
          'Persisted session state must be a JSON object.',
        );
      });
    });
  });

  describe('getConnectionOptionsFromUri', () => {
    it('should parse postgresql URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
      );
      expect(options.driver).toBeDefined();
      expect(options.clientUrl).toBe('postgres://user:pass@localhost:5432/db');
    });

    it('should parse postgresql URI with query params and preserve them in clientUrl', async () => {
      const uri = 'postgres://user:pass@localhost:5432/db?sslmode=require';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
    });

    it('should parse postgresql Unix-socket URI with percent-encoded host', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
    });

    it('should parse postgresql Unix-socket URI with query param host', async () => {
      const uri =
        'postgresql://user:pass@/mydb?host=/cloudsql/my-project:us-central1:my-instance';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
    });

    it('should parse mysql URI', async () => {
      const uri = 'mysql://user:pass@localhost:3306/db';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driver).toBeDefined();
      expect(options.clientUrl).toBe(uri);
    });

    it('should parse mariadb URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'mariadb://user:pass@localhost:3306/db',
      );
      expect(options.driver).toBeDefined();
    });

    it('should parse mssql URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'mssql://user:pass@localhost:1433/db',
      );
      expect(options.driver).toBeDefined();
    });

    it('should parse sqlite://:memory: special case', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');
      expect(options.dbName).toBe(':memory:');
      expect(options.driver).toBe(SqliteDriver);
      // SQLite memory options don't have host/port/etc.
      expect(options).not.toHaveProperty('host');
    });

    it('should parse sqlite filepath URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite:///tmp/test.db',
      );
      expect(options.dbName).toBe('/tmp/test.db');
      expect(options.driver).toBe(SqliteDriver);
    });

    it('should throw error for unsupported backend', async () => {
      await expect(
        getConnectionOptionsFromUri('invalid://user:pass@localhost/db'),
      ).rejects.toThrow('Unsupported database URI');
    });

    it('resolves a driver for an uppercase scheme, as the constructor accepts', async () => {
      const options = await getConnectionOptionsFromUri(
        'POSTGRES://user:pass@localhost:5432/db',
      );

      expect(options.driver).toBeDefined();
    });

    it('pins the pool for an uppercase sqlite in-memory URI', async () => {
      const options = await getConnectionOptionsFromUri('SQLITE://:memory:');

      expect(options.dbName).toBe(':memory:');
      expect(options.pool).toEqual({min: 1, max: 1});
    });

    it('pins the sqlite in-memory pool to a single connection', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');
      expect(options.pool).toEqual({min: 1, max: 1});
    });

    it('leaves the pool alone for a sqlite file', async () => {
      const options = await getConnectionOptionsFromUri('sqlite:///tmp/a.db');
      expect(options.pool).toBeUndefined();
    });

    it('installs the foreign-key hook on every sqlite connection', async () => {
      const options = await getConnectionOptionsFromUri('sqlite:///tmp/a.db');
      expect(options.driverOptions).toEqual({
        pool: {afterCreate: enableSqliteForeignKeys},
      });
    });

    it('installs the liveness check on a non-sqlite backend', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
      );
      expect(options.driverOptions).toEqual({
        pool: {validate: connectionIsAlive},
      });
    });

    it('reports a string that is not a URI at all', async () => {
      await expect(
        getConnectionOptionsFromUri('definitely not a url'),
      ).rejects.toThrow('Invalid database URL format or argument');
    });

    it('names the driver a SQLAlchemy-style sqlite scheme carries', async () => {
      await expect(
        getConnectionOptionsFromUri('sqlite+aiosqlite:///sessions.db'),
      ).rejects.toThrow(/'aiosqlite' driver.*'sqlite:\/\/' URL instead/s);
    });

    it('keeps the password out of every rejection message', async () => {
      const password = 'sup3rs3cret';
      await expect(
        getConnectionOptionsFromUri(`oracle://user:${password}@host/db`),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(password),
        }),
      );
      await expect(
        getConnectionOptionsFromUri(`postgresql+asyncpg://u:${password}@h/db`),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(password),
        }),
      );
    });

    it('still reports an unsupported backend as unsupported', async () => {
      await expect(
        getConnectionOptionsFromUri('oracle://user:pw@host/db'),
      ).rejects.toThrow('Unsupported database URI');
    });

    it('merges caller overrides over the derived options', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:', {
        pool: {min: 2, max: 4},
        debug: true,
      });
      expect(options.pool).toEqual({min: 2, max: 4});
      expect(options.debug).toBe(true);
      expect(options.dbName).toBe(':memory:');
    });

    it('turns foreign keys on for every sqlite connection the pool opens', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');
      expect(options.driverOptions?.['pool']).toEqual({
        afterCreate: enableSqliteForeignKeys,
      });
    });

    it('leaves a sqlite URI without a query string on the plain file name', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite:///tmp/test.db',
      );
      expect(options.driverOptions?.['connection']).toBeUndefined();
    });

    it('hands a sqlite query string to the driver as a file URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite://./sessions.db?mode=ro',
      );
      expect(options.dbName).toBe('./sessions.db');
      expect(options.driverOptions?.['connection']).toEqual({
        filename: 'file:./sessions.db?mode=ro',
        flags: ['OPEN_URI'],
      });
    });
  });

  describe('parseSqliteUri', () => {
    it.each([
      ['sqlite://:memory:', ':memory:'],
      ['sqlite://./sessions.db', './sessions.db'],
      ['sqlite:///abs/path.db', '/abs/path.db'],
      ['sqlite://my%20db.db', 'my%20db.db'],
    ])('resolves %s to the same path it resolves to today', (uri, dbName) => {
      expect(parseSqliteUri(uri)).toEqual({dbName, query: ''});
    });

    it('splits a trailing query string off the path', () => {
      expect(parseSqliteUri('sqlite:///abs/path.db?mode=ro')).toEqual({
        dbName: '/abs/path.db',
        query: 'mode=ro',
      });
    });

    it('percent-decodes the path once a query string is present', () => {
      expect(parseSqliteUri('sqlite://my%20db.db?mode=ro')).toEqual({
        dbName: 'my db.db',
        query: 'mode=ro',
      });
    });

    it('keeps every parameter of a multi-parameter query string', () => {
      expect(parseSqliteUri('sqlite://a.db?mode=ro&cache=shared')).toEqual({
        dbName: 'a.db',
        query: 'mode=ro&cache=shared',
      });
    });

    it('reports an empty query string for a bare trailing question mark', () => {
      expect(parseSqliteUri('sqlite://a.db?')).toEqual({
        dbName: 'a.db',
        query: '',
      });
    });
  });

  describe('detectDatabaseSchemaVersion', () => {
    let orm: MikroORM;

    afterEach(async () => {
      await orm.close();
    });

    async function initEmptyOrm(): Promise<MikroORM> {
      return MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        pool: {min: 1, max: 1},
      });
    }

    it('reports the latest version for an empty database', async () => {
      orm = await initEmptyOrm();
      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_1_JSON,
      );
    });

    it('reports the version stored in the metadata table', async () => {
      orm = await initEmptyOrm();
      await ensureDatabaseCreated(orm);
      const em = orm.em.fork();
      await em
        .persist(
          em.create(StorageMetadata, {key: SCHEMA_VERSION_KEY, value: '7'}),
        )
        .flush();

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe('7');
    });

    it('rejects a metadata table that holds no schema version', async () => {
      orm = await initEmptyOrm();
      await orm.em
        .getConnection()
        .execute(
          `create table ${METADATA_TABLE_NAME} ("key" text primary key, value text)`,
        );

      await expect(detectDatabaseSchemaVersion(orm)).rejects.toThrow(
        'might be malformed',
      );
    });

    it('reports the legacy version for a pickle events table', async () => {
      orm = await initEmptyOrm();
      await orm.em
        .getConnection()
        .execute(
          `create table ${EVENTS_TABLE_NAME} (id text primary key, actions blob)`,
        );

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_0_PICKLE,
      );
    });

    it('reports the latest version when the events table already holds event_data', async () => {
      orm = await initEmptyOrm();
      await orm.em
        .getConnection()
        .execute(
          `create table ${EVENTS_TABLE_NAME} (id text primary key, actions blob, event_data text)`,
        );

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_1_JSON,
      );
    });
  });

  describe('enableSqliteForeignKeys', () => {
    it('runs the pragma and hands the connection back to the pool', () => {
      const statements: string[] = [];
      const connection = {
        run(sql: string, callback: (error: Error | null) => void) {
          statements.push(sql);
          callback(null);
        },
      };

      let reported: Error | null = new Error('the hook never called back');
      let handedBack: unknown;
      enableSqliteForeignKeys(connection, (error, opened) => {
        reported = error;
        handedBack = opened;
      });

      expect(statements).toEqual(['PRAGMA foreign_keys = ON']);
      expect(reported).toBeNull();
      expect(handedBack).toBe(connection);
    });

    it('reports a pragma failure to the pool', () => {
      const failure = new Error('disk I/O error');
      const statements: string[] = [];
      const connection = {
        run(sql: string, callback: (error: Error | null) => void) {
          statements.push(sql);
          callback(failure);
        },
      };

      let reported: Error | null = null;
      enableSqliteForeignKeys(connection, (error) => {
        reported = error;
      });

      expect(statements).toEqual(['PRAGMA foreign_keys = ON']);
      expect(reported).toBe(failure);
    });

    it('keeps foreign keys on for every connection of a wider pool', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'adk-sqlite-pragma-'));
      const options = await getConnectionOptionsFromUri(
        `sqlite://${join(directory, 'sessions.db')}`,
        {pool: {min: 0, max: 4}},
      );
      const orm = await MikroORM.init(options);

      try {
        const connection = orm.em.getConnection();
        // More work than the pool is wide, so knex opens every connection it
        // is allowed to and each one has to answer for itself.
        const reads: Array<Promise<Array<{foreign_keys: number}>>> = Array.from(
          {length: 8},
          () => connection.execute('pragma foreign_keys', [], 'all'),
        );
        const results = await Promise.all(reads);

        expect(results.map((rows) => rows[0].foreign_keys)).toEqual(
          Array.from({length: 8}, () => 1),
        );
      } finally {
        await orm.close();
        await rm(directory, {recursive: true, force: true});
      }
    });
  });

  /** The statement method a raw `sqlite3` connection exposes. */
  interface SqliteAllConnection {
    all(sql: string, callback: (error: Error | null) => void): void;
  }

  describe('connectionIsAlive', () => {
    it('reports a connection that answers the probe', async () => {
      const statements: string[] = [];
      const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
          statements.push(sql);
          callback(null);
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(true);
      expect(statements).toEqual(['select 1']);
    });

    it('reports a connection whose probe fails', async () => {
      const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
          callback(new Error(`server closed the connection: ${sql}`));
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('reports a connection that rejects the probe synchronously', async () => {
      const connection = {
        query(): never {
          throw new Error('connection is destroyed');
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('leaves a driver that takes no statement to knex', async () => {
      await expect(connectionIsAlive({execSql: () => undefined})).resolves.toBe(
        true,
      );
    });

    it('is consulted by the pool before it reuses a connection', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'adk-sqlite-validate-'));
      const checks: boolean[] = [];
      const orm = await MikroORM.init({
        dbName: join(directory, 'sessions.db'),
        driver: SqliteDriver,
        entities: ENTITIES,
        pool: {min: 0, max: 1},
        driverOptions: {
          pool: {
            // sqlite3 names its statement method `all`, so the probe reaches a
            // real pooled connection through this adapter. A socket backend
            // exposes `query` and needs none.
            async validate(connection: SqliteAllConnection) {
              checks.push(
                await connectionIsAlive({
                  query: (
                    sql: string,
                    callback: (error: Error | null) => void,
                  ) => connection.all(sql, callback),
                }),
              );
              return true;
            },
          },
        },
      });

      try {
        const connection = orm.em.getConnection();
        await connection.execute('select 1 as probe', [], 'all');
        await connection.execute('select 1 as probe', [], 'all');

        // The first statement opens the connection, so only its reuse is
        // validated. A hook the pool never calls would leave this empty.
        expect(checks.length).toBeGreaterThan(0);
        expect(checks.every((alive) => alive)).toBe(true);
      } finally {
        await orm.close();
        await rm(directory, {recursive: true, force: true});
      }
    });
  });

  describe('getOrCreateRow', () => {
    let orm: MikroORM;

    afterEach(async () => {
      await orm.close();
    });

    async function initPreparedOrm(): Promise<MikroORM> {
      const prepared = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        pool: {min: 1, max: 1},
        allowGlobalContext: true,
      });
      await ensureDatabaseCreated(prepared);
      return prepared;
    }

    it('returns the row that is already stored', async () => {
      orm = await initPreparedOrm();
      const seeder = orm.em.fork();
      await seeder
        .persist(
          seeder.create(StorageAppState, {
            appName: 'app',
            state: {'seeded': true},
            updateTime: new Date(),
          }),
        )
        .flush();

      const row = await getOrCreateRow(
        orm.em.fork(),
        StorageAppState,
        {appName: 'app'},
        {appName: 'app', state: {}, updateTime: new Date()},
      );

      expect(row.state).toEqual({'seeded': true});
    });

    it('inserts the row when it is absent', async () => {
      orm = await initPreparedOrm();

      const row = await getOrCreateRow(
        orm.em.fork(),
        StorageAppState,
        {appName: 'app'},
        {appName: 'app', state: {'fresh': true}, updateTime: new Date()},
      );

      expect(row.state).toEqual({'fresh': true});
      expect(await orm.em.fork().count(StorageAppState, {appName: 'app'})).toBe(
        1,
      );
    });

    it('returns the winner row when a concurrent caller inserts first', async () => {
      orm = await initPreparedOrm();
      const defaults = {appName: 'app', state: {}, updateTime: new Date()};

      const rows = await Promise.all([
        getOrCreateRow(
          orm.em.fork(),
          StorageAppState,
          {appName: 'app'},
          defaults,
        ),
        getOrCreateRow(
          orm.em.fork(),
          StorageAppState,
          {appName: 'app'},
          defaults,
        ),
      ]);

      expect(rows.map((row) => row.appName)).toEqual(['app', 'app']);
      expect(await orm.em.fork().count(StorageAppState, {appName: 'app'})).toBe(
        1,
      );
    });

    it('rethrows an insert failure that left no row behind', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        pool: {min: 1, max: 1},
        allowGlobalContext: true,
      });
      // A constraint the entity does not know about: the insert fails, the
      // read that follows it succeeds and still finds nothing, so the failure
      // is not a lost race.
      await orm.em
        .getConnection()
        .execute(
          'create table app_states (app_name text primary key, state text ' +
            "not null check (state <> '{}'), update_time datetime)",
        );

      await expect(
        getOrCreateRow(
          orm.em.fork(),
          StorageAppState,
          {appName: 'app'},
          {appName: 'app', state: {}, updateTime: new Date()},
        ),
      ).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe('engine options', () => {
    const NON_SQLITE_URIS = [
      'postgres://user:pass@localhost:5432/db',
      'postgresql://user:pass@localhost:5432/db',
      'mysql://user:pass@localhost:3306/db',
      'mariadb://user:pass@localhost:3306/db',
      'mssql://user:pass@localhost:1433/db',
    ];
    const SQLITE_URIS = ['sqlite://:memory:', 'sqlite:///tmp/test.db'];

    it('gives a sqlite in-memory database a single-connection pool', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');

      expect(options.pool).toEqual({min: 1, max: 1});
    });

    it('leaves a file-backed sqlite database on the default pool', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite:///tmp/test.db',
      );

      expect(options.pool).toBeUndefined();
    });

    it.each(SQLITE_URIS)('installs the pragma hook for %s', async (uri) => {
      const options = await getConnectionOptionsFromUri(uri);

      expect(options.driverOptions).toEqual({
        pool: {afterCreate: enableSqliteForeignKeys},
      });
    });

    it.each(NON_SQLITE_URIS)(
      'installs the liveness probe for %s',
      async (uri) => {
        const options = await getConnectionOptionsFromUri(uri);

        expect(options.driverOptions).toEqual({
          pool: {validate: connectionIsAlive},
        });
      },
    );

    it('lets overrides replace a derived option', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:', {
        pool: {min: 2, max: 8},
        dbName: 'replaced.db',
      });

      expect(options.pool).toEqual({min: 2, max: 8});
      expect(options.dbName).toBe('replaced.db');
    });
  });

  describe('enableSqliteForeignKeys', () => {
    it('runs the pragma and hands the connection back', () => {
      const statements: string[] = [];
      const connection = {
        run(sql: string, callback: (error: Error | null) => void) {
          statements.push(sql);
          callback(null);
        },
      };
      const done = vi.fn();

      enableSqliteForeignKeys(connection, done);

      expect(statements).toEqual(['PRAGMA foreign_keys = ON']);
      expect(done).toHaveBeenCalledWith(null, connection);
    });

    it('passes a pragma failure through to the callback', () => {
      const failure = new Error('database is locked');
      const connection = {
        run(sql: string, callback: (error: Error | null) => void) {
          expect(sql).toBe('PRAGMA foreign_keys = ON');
          callback(failure);
        },
      };
      const done = vi.fn();

      enableSqliteForeignKeys(connection, done);

      expect(done).toHaveBeenCalledWith(failure, connection);
    });
  });

  describe('connectionIsAlive', () => {
    it('reports a connection alive when the probe answers', async () => {
      const statements: string[] = [];
      const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
          statements.push(sql);
          callback(null);
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(true);
      expect(statements).toEqual(['select 1']);
    });

    it('reports a connection dead when the probe errors', async () => {
      const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
          expect(sql).toBe('select 1');
          callback(new Error('server closed the connection unexpectedly'));
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('reports a connection dead when the probe throws', async () => {
      const connection = {
        query() {
          throw new Error('Cannot use a destroyed connection');
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('reports a connection with no query method alive', async () => {
      await expect(connectionIsAlive({})).resolves.toBe(true);
    });
  });

  describe('assertSupportedDatabaseUri', () => {
    const PASSWORD = 'sup3r-s3cret';

    function rejectionMessage(uri: string): string {
      try {
        assertSupportedDatabaseUri(uri);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      expect.fail(`expected ${uri} to be rejected`);
    }

    it('rejects a string that is not a URL, without echoing it', () => {
      const message = rejectionMessage(`definitely not a url ${PASSWORD}`);

      expect(message).toContain('Invalid database URL format or argument');
      expect(message).not.toContain(PASSWORD);
    });

    it('rejects a scheme naming an unsupported backend', () => {
      expect(rejectionMessage('oracle://host/db')).toContain(
        'Unsupported database URI',
      );
    });

    it('rejects a scheme that only names an Object prototype member', () => {
      expect(rejectionMessage('constructor://host/db')).toContain(
        'Unsupported database URI',
      );
    });

    it.each([
      ['postgresql+asyncpg', 'postgresql'],
      ['postgresql+psycopg2', 'postgresql'],
    ])('rejects the %s scheme and names its driver', (scheme, backend) => {
      const driver = scheme.split('+')[1];
      const message = rejectionMessage(
        `${scheme}://user:${PASSWORD}@host:5432/db`,
      );

      expect(message).toContain(`names the '${driver}' driver in its scheme`);
      expect(message).toContain(`use a '${backend}://' URL instead`);
      expect(message).toContain(`${scheme}://user:***@host:5432/db`);
      expect(message).not.toContain(PASSWORD);
    });

    it('rejects a sqlite URL naming an async driver', () => {
      const message = rejectionMessage('sqlite+aiosqlite:///x.db');

      expect(message).toContain("names the 'aiosqlite' driver in its scheme");
      expect(message).toContain("use a 'sqlite://' URL instead");
    });

    it('accepts every supported backend without a driver suffix', () => {
      for (const uri of [
        'postgres://host/db',
        'postgresql://host/db',
        'mysql://host/db',
        'mariadb://host/db',
        'mssql://host/db',
        'sqlite://:memory:',
      ]) {
        expect(() => assertSupportedDatabaseUri(uri)).not.toThrow();
      }
    });
  });

  describe('namesSupportedDatabaseBackend', () => {
    it('claims a driver-suffixed URI so the caller hears the real reason', () => {
      expect(
        namesSupportedDatabaseBackend('postgresql+asyncpg://host/db'),
      ).toBe(true);
    });

    it('claims a plain supported URI', () => {
      expect(namesSupportedDatabaseBackend('sqlite://:memory:')).toBe(true);
    });

    it('disclaims an unsupported backend and a string with no scheme', () => {
      expect(namesSupportedDatabaseBackend('oracle://host/db')).toBe(false);
      expect(namesSupportedDatabaseBackend('just some text')).toBe(false);
    });

    it('disclaims a scheme that only names an Object prototype member', () => {
      expect(namesSupportedDatabaseBackend('constructor://host/db')).toBe(
        false,
      );
    });
  });

  describe('ensureDatabaseCreated', () => {
    let orm: MikroORM;

    afterEach(async () => {
      resetLogger();
      if (orm) {
        await orm.close();
      }
    });

    it('should run successfully with MikroORM instance', async () => {
      // Create a real SQLite in-memory instance
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata], // Minimal entities
      });

      // Verify it runs without error
      await expect(ensureDatabaseCreated(orm)).resolves.not.toThrow();
    });

    /**
     * MySQL emits the foreign key as its own `alter table` against a table
     * that already exists, and rejects it when that table already holds rows
     * the constraint forbids. The statements are stubbed because the failure
     * needs a server that enforces foreign keys on an alter, and the suite
     * runs on sqlite.
     */
    it('applies the other statements when the database refuses a foreign key', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata],
      });
      vi.spyOn(orm.schema, 'getUpdateSchemaSQL').mockResolvedValue(
        [
          'create table `late` (`id` text not null, primary key (`id`));',
          'alter table `late` add constraint `late_fk` foreign key (`id`) references `missing` (`id`) on delete cascade;',
          "insert into `late` values ('kept');",
        ].join('\n'),
      );
      const warnings: unknown[][] = [];
      setLogger({
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => warnings.push(args),
        error: () => {},
      });

      await expect(ensureDatabaseCreated(orm)).resolves.not.toThrow();

      const rows = await orm.em
        .getConnection()
        .execute('select `id` from `late`');
      expect(rows).toEqual([{id: 'kept'}]);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain('left it off');
    });

    it('still fails when a statement other than a foreign key fails', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata],
      });
      vi.spyOn(orm.schema, 'getUpdateSchemaSQL').mockResolvedValue(
        'create table `broken` (this is not sql);',
      );

      await expect(ensureDatabaseCreated(orm)).rejects.toThrow();
    });
  });

  describe('validateDatabaseSchemaVersion', () => {
    let orm: MikroORM;

    beforeEach(async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata],
      });
      // Ensure schema is updated so StorageMetadata table exists
      await orm.schema.updateSchema();
    });

    afterEach(async () => {
      await orm.close();
    });

    it('should initialize schema version if missing', async () => {
      const em = orm.em.fork();
      const initial = await em.find(StorageMetadata, {});
      expect(initial.length).toBe(0);

      await validateDatabaseSchemaVersion(orm);

      const after = await em.find(StorageMetadata, {});
      expect(after.length).toBe(1);
      expect(after[0].key).toBe(SCHEMA_VERSION_KEY);
      expect(after[0].value).toBe(SCHEMA_VERSION_1_JSON);
    });

    it('should do nothing if schema version is correct', async () => {
      const em = orm.em.fork();
      const version = em.create(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
        value: SCHEMA_VERSION_1_JSON,
      });
      await em.persist(version).flush();

      await expect(validateDatabaseSchemaVersion(orm)).resolves.not.toThrow();
    });

    it('should throw error if schema version is incompatible', async () => {
      const em = orm.em.fork();
      const version = em.create(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
        value: '999',
      });
      await em.persist(version).flush();

      await expect(validateDatabaseSchemaVersion(orm)).rejects.toThrow(
        'ADK Database schema version 999 is not compatible',
      );
    });
  });

  describe('detectDatabaseSchemaVersion', () => {
    let orm: MikroORM;

    afterEach(async () => {
      await orm.close();
    });

    async function openCurrentSchema(created: boolean): Promise<MikroORM> {
      const instance = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        allowGlobalContext: true,
      });
      if (created) {
        await instance.schema.createSchema();
      }
      return instance;
    }

    it('reports the current version for an empty database', async () => {
      orm = await openCurrentSchema(false);

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_1_JSON,
      );
    });

    it('reports the version the metadata row records', async () => {
      orm = await openCurrentSchema(true);
      const em = orm.em.fork();
      await em
        .persist(
          em.create(StorageMetadata, {
            key: SCHEMA_VERSION_KEY,
            value: SCHEMA_VERSION_1_JSON,
          }),
        )
        .flush();

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_1_JSON,
      );
    });

    it('throws when the metadata table records no version', async () => {
      orm = await openCurrentSchema(true);

      await expect(detectDatabaseSchemaVersion(orm)).rejects.toThrow(
        'Schema version not found in adk_internal_metadata',
      );
    });

    it('reports the legacy version for a v0 events table', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES_V0,
        allowGlobalContext: true,
      });
      await orm.schema.createSchema();

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_0_PICKLE,
      );
    });
  });

  describe('getOrCreateRow', () => {
    let orm: MikroORM;

    beforeEach(async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        allowGlobalContext: true,
      });
      await orm.schema.createSchema();
    });

    afterEach(async () => {
      await orm.close();
    });

    async function seedAppState(
      appName: string,
      state: Record<string, unknown>,
    ): Promise<void> {
      const em = orm.em.fork();
      await em
        .persist(
          em.create(StorageAppState, {appName, state, updateTime: new Date()}),
        )
        .flush();
    }

    it('returns the existing row without inserting another', async () => {
      await seedAppState('app', {seeded: true});
      const em = orm.em.fork();

      const row = await getOrCreateRow(
        em,
        StorageAppState,
        {appName: 'app'},
        {appName: 'app', state: {}, updateTime: new Date()},
      );

      expect(row.state).toEqual({seeded: true});
      expect(await orm.em.fork().count(StorageAppState, {})).toBe(1);
    });

    it('creates the row when it is absent', async () => {
      const em = orm.em.fork();

      const row = await getOrCreateRow(
        em,
        StorageAppState,
        {appName: 'app'},
        {appName: 'app', state: {created: true}, updateTime: new Date()},
      );

      expect(row.appName).toBe('app');
      expect(row.state).toEqual({created: true});
      expect(await orm.em.fork().count(StorageAppState, {})).toBe(1);
    });

    it('returns the winner row when a concurrent caller inserted first', async () => {
      await seedAppState('app', {winner: true});
      const em = orm.em.fork();
      // The losing caller's view of the race: its own read misses the row that
      // is already stored, so its insert hits the winner's. Python's test
      // simulates the same view by patching `session.get`.
      vi.spyOn(em, 'findOne').mockResolvedValueOnce(null);

      const row = await getOrCreateRow(
        em,
        StorageAppState,
        {appName: 'app'},
        {appName: 'app', state: {loser: true}, updateTime: new Date()},
      );

      expect(row.state).toEqual({winner: true});
      expect(await orm.em.fork().count(StorageAppState, {})).toBe(1);
    });

    it('rethrows when the insert fails and the row is still absent', async () => {
      // The insert collides with a different row, so the error class says
      // "duplicate" while the row the caller asked for never appears. Evidence
      // decides, not the error class.
      await seedAppState('taken', {});
      const em = orm.em.fork();

      await expect(
        getOrCreateRow(
          em,
          StorageAppState,
          {appName: 'absent'},
          {appName: 'taken', state: {}, updateTime: new Date()},
        ),
      ).rejects.toThrow(/unique/i);
      expect(await orm.em.fork().count(StorageAppState, {})).toBe(1);
    });
  });

  describe('schemeOf', () => {
    it('splits a backend and a driver suffix, lowercased', () => {
      expect(schemeOf('PostgreSQL+AsyncPG://host/db')).toEqual({
        backend: 'postgresql',
        driver: 'asyncpg',
      });
    });

    it('reports no driver for a plain scheme', () => {
      expect(schemeOf('sqlite:///tmp/x.db')).toEqual({backend: 'sqlite'});
    });

    it('reports an empty backend for a string with no scheme', () => {
      expect(schemeOf('definitely not a url')).toEqual({backend: ''});
    });
  });

  describe('supportsRowLevelLocking', () => {
    it('locks on the dialects adk-python locks', () => {
      expect(supportsRowLevelLocking('mysql')).toBe(true);
      expect(supportsRowLevelLocking('mariadb')).toBe(true);
      expect(supportsRowLevelLocking('postgresql')).toBe(true);
    });

    it('does not lock on sqlite or mssql', () => {
      expect(supportsRowLevelLocking('sqlite')).toBe(false);
      expect(supportsRowLevelLocking('mssql')).toBe(false);
      expect(supportsRowLevelLocking('')).toBe(false);
    });
  });

  describe('getDatabaseBackend', () => {
    let orm: MikroORM;

    afterEach(async () => {
      if (orm) {
        await orm.close();
      }
    });

    it("maps the driver's sqlite3 dialect onto sqlite", async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });

      expect(getDatabaseBackend(orm)).toBe('sqlite');
    });
  });

  describe('dialectOf', () => {
    it('reports an empty backend for a connection exposing no knex handle', () => {
      expect(dialectOf({})).toBe('');
    });

    it('reports an empty backend when the knex handle carries no client', () => {
      expect(dialectOf({getKnex: () => ({})})).toBe('');
    });

    it('reports an empty backend when the knex client names no dialect', () => {
      expect(dialectOf({getKnex: () => ({client: {}})})).toBe('');
    });

    it('passes a non-sqlite dialect through unchanged', () => {
      const connection = {getKnex: () => ({client: {dialect: 'postgresql'}})};

      expect(dialectOf(connection)).toBe('postgresql');
    });
  });

  describe('openDatabaseOrm', () => {
    /** Options MikroORM rejects during discovery, before it connects. */
    class UndecoratedEntity {}
    const unopenableOptions = {
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: [UndecoratedEntity],
    };

    it('leaves an options-object failure unchanged, having no URL to name', async () => {
      await expect(openDatabaseOrm(unopenableOptions)).rejects.toThrow(
        /Only abstract entities were discovered/,
      );
    });

    it('names the redacted URL when the engine cannot be created', async () => {
      const password = 'hunter2';
      const original = await openDatabaseOrm(unopenableOptions).catch(
        (error: unknown) => error,
      );
      if (!(original instanceof Error)) {
        expect.fail('the unopenable options were expected to throw an Error');
      }

      const thrown = await openDatabaseOrm(
        unopenableOptions,
        `postgres://user:${password}@localhost:5432/db`,
      ).catch((error: unknown) => error);
      if (!(thrown instanceof Error)) {
        expect.fail('the unopenable options were expected to throw an Error');
      }

      expect(thrown.message).toBe(
        'Failed to create database engine for URL ' +
          "'postgres://user:***@localhost:5432/db'",
      );
      expect(thrown.message).not.toContain(password);
      expect(thrown.cause).toBeInstanceOf(Error);
      expect((thrown.cause as Error).message).toBe(original.message);
    });
  });

  describe('forkForRead and forkForWrite', () => {
    let orm: MikroORM;

    beforeEach(async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });
      await orm.schema.updateSchema();
    });

    afterEach(async () => {
      await orm.close();
    });

    it('hands out a separate unit of work per call', () => {
      const read = forkForRead(orm);
      const write = forkForWrite(orm);

      expect(read).not.toBe(write);
      expect(read).not.toBe(orm.em);
      expect(write).not.toBe(orm.em);
    });

    it('keeps a read fork from flushing a change to storage', async () => {
      const read = forkForRead(orm);
      read.create(StorageMetadata, {key: 'from-read', value: 'x'});

      // An implicit flush would run here under the default flush mode.
      await read.find(StorageMetadata, {});

      const inspector = forkForRead(orm);
      expect(await inspector.find(StorageMetadata, {})).toEqual([]);
    });

    it('lets a write fork flush a change to storage', async () => {
      const write = forkForWrite(orm);
      write.create(StorageMetadata, {key: 'from-write', value: 'y'});
      await write.flush();

      const inspector = forkForRead(orm);
      const stored = await inspector.find(StorageMetadata, {});
      expect(stored.map((row) => row.key)).toEqual(['from-write']);
    });
  });
});
