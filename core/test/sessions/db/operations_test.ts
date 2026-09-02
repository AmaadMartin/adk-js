/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  assertSupportedDatabaseUri,
  connectionIsAlive,
  detectDatabaseSchemaVersion,
  enableSqliteForeignKeys,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  getOrCreateRow,
  namesSupportedDatabaseBackend,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/operations.js';
import {
  ENTITIES,
  SCHEMA_VERSION_0_PICKLE,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageAppState,
  StorageEvent,
  StorageMetadata,
} from '../../../src/sessions/db/schema.js';
import {ENTITIES_V0} from '../../../src/sessions/db/schema_v0.js';
import {logger} from '../../../src/utils/logger.js';

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
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await expect(detectDatabaseSchemaVersion(orm)).resolves.toBe(
        SCHEMA_VERSION_0_PICKLE,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('adk migrate session'),
      );
      warn.mockRestore();
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
});
