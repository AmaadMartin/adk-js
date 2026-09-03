/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  connectionIsAlive,
  databaseBackendOf,
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  getOrCreateRow,
  prePingPoolOptions,
  READ_ONLY,
  sessionSchemaFor,
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
import {
  StorageAppStateV0,
  StorageSessionV0,
  StorageUserStateV0,
} from '../../../src/sessions/db/schema_v0.js';

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

      // MySQL and MariaDB emit `datetime` with no fractional digits unless the
      // property declares a length, and the whole-second value that column
      // holds would round away the millisecond the revision marker and the
      // event ordering both compare.
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
          {length?: number}
        >;
        // Asserted against the literal, not the constant, so that lowering the
        // constant fails here instead of moving both sides together.
        expect(properties[property].length).toBe(3);
      }
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

    it('should throw error for unsupported driver', async () => {
      await expect(
        getConnectionOptionsFromUri('invalid://user:pass@localhost/db'),
      ).rejects.toThrow('Unsupported database URI');
    });

    it('pins the sqlite in-memory pool to a single connection', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');
      expect(options.pool).toEqual({min: 1, max: 1});
    });

    it('leaves the pool alone for a sqlite file', async () => {
      const options = await getConnectionOptionsFromUri('sqlite:///tmp/a.db');
      expect(options.pool).toBeUndefined();
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

  describe('ensureDatabaseCreated', () => {
    let orm: MikroORM;

    afterEach(async () => {
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
  describe('prePingPoolOptions', () => {
    it('gives a non-sqlite URI a connection check', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
      );

      expect(options.pool).toEqual(prePingPoolOptions().pool);
      expect(prePingPoolOptions().pool.validate).toBe(connectionIsAlive);
    });

    it('leaves sqlite without one', async () => {
      const memory = await getConnectionOptionsFromUri('sqlite://:memory:');
      const file = await getConnectionOptionsFromUri('sqlite:///tmp/a.db');

      expect(memory.pool).not.toHaveProperty('validate');
      expect(file.pool).toBeUndefined();
    });

    it('lets the caller switch the check off through the overrides', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
        {pool: {min: 2, max: 8}},
      );

      expect(options.pool).toEqual({min: 2, max: 8});
      expect(options.pool).not.toHaveProperty('validate');
    });

    it('hands back a fresh options object each call', () => {
      expect(prePingPoolOptions().pool).not.toBe(prePingPoolOptions().pool);
    });
  });

  describe('sqlite foreign keys', () => {
    let orm: MikroORM;

    afterEach(async () => {
      await orm.close();
    });

    it('are on for every sqlite connection MikroORM opens', async () => {
      orm = await MikroORM.init(
        await getConnectionOptionsFromUri('sqlite://:memory:'),
      );

      const rows: Array<{foreign_keys: number}> = await orm.em
        .getConnection()
        .execute('pragma foreign_keys', [], 'all');

      expect(rows).toEqual([{foreign_keys: 1}]);
    });
  });

  describe('connectionIsAlive', () => {
    it('accepts a connection whose query answers', async () => {
      const queried: string[] = [];
      const connection = {
        query(sql: string, callback: (error?: unknown) => void) {
          queried.push(sql);
          callback();
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(true);
      expect(queried).toEqual(['select 1']);
    });

    it('rejects a connection whose query fails', async () => {
      const connection = {
        query(_sql: string, callback: (error?: unknown) => void) {
          callback(new Error('server closed the connection'));
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('rejects a connection whose query throws outright', async () => {
      const connection = {
        query() {
          throw new Error('socket destroyed');
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('accepts a connection it cannot probe', async () => {
      await expect(connectionIsAlive({})).resolves.toBe(true);
      await expect(connectionIsAlive(undefined)).resolves.toBe(true);
      await expect(connectionIsAlive(null)).resolves.toBe(true);
      await expect(connectionIsAlive({query: 'not a function'})).resolves.toBe(
        true,
      );
    });
  });

  describe('supportsRowLevelLocking', () => {
    it('accepts the backends that take a row lock', () => {
      expect(supportsRowLevelLocking('mysql')).toBe(true);
      expect(supportsRowLevelLocking('mariadb')).toBe(true);
      expect(supportsRowLevelLocking('postgresql')).toBe(true);
    });

    it('refuses the backends that do not', () => {
      expect(supportsRowLevelLocking('sqlite')).toBe(false);
      expect(supportsRowLevelLocking('mssql')).toBe(false);
      expect(supportsRowLevelLocking('oracle')).toBe(false);
      expect(supportsRowLevelLocking('')).toBe(false);
    });
  });

  describe('databaseBackendOf', () => {
    let orm: MikroORM;

    afterEach(async () => {
      await orm.close();
    });

    it('translates the knex sqlite dialect to the adk-python name', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
        pool: {min: 1, max: 1},
      });

      const backend = databaseBackendOf(orm.em.getConnection());

      expect(backend).toBe('sqlite');
      expect(supportsRowLevelLocking(backend)).toBe(false);
    });

    it('passes a non-sqlite dialect through unchanged', () => {
      const postgres = {getKnex: () => ({client: {dialect: 'postgresql'}})};

      expect(databaseBackendOf(postgres)).toBe('postgresql');
      expect(supportsRowLevelLocking(databaseBackendOf(postgres))).toBe(true);
    });

    it('names no backend for a connection with no knex handle', () => {
      expect(databaseBackendOf({})).toBe('');
      expect(databaseBackendOf({getKnex: 'not a function'})).toBe('');
    });
  });

  describe('READ_ONLY', () => {
    it('cannot be mutated by a caller that passes it straight through', () => {
      expect(READ_ONLY.connectionType).toBe('read');
      expect(Object.isFrozen(READ_ONLY)).toBe(true);
    });
  });

  describe('sessionSchemaFor', () => {
    it('selects the legacy entity set only for the legacy version', () => {
      const legacy = sessionSchemaFor(SCHEMA_VERSION_0_PICKLE);
      const current = sessionSchemaFor(SCHEMA_VERSION_1_JSON);

      expect(legacy.sessions).toBe(StorageSessionV0);
      expect(legacy.appStates).toBe(StorageAppStateV0);
      expect(legacy.userStates).toBe(StorageUserStateV0);
      expect(current.sessions).toBe(StorageSession);
      expect(current.appStates).toBe(StorageAppState);
      expect(current.userStates).toBe(StorageUserState);
    });

    it('falls back to the current entity set for an unknown version', () => {
      expect(sessionSchemaFor('7').sessions).toBe(StorageSession);
    });
  });
});
