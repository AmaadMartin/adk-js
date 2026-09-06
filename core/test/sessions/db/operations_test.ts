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
  dialectOf,
  enableSqliteForeignKeys,
  ensureDatabaseCreated,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  namesSupportedDatabaseBackend,
  openDatabaseOrm,
  schemeOf,
  supportsRowLevelLocking,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/operations.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageEvent,
  StorageMetadata,
} from '../../../src/sessions/db/schema.js';

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

    it('should throw error for unsupported driver', async () => {
      await expect(
        getConnectionOptionsFromUri('invalid://user:pass@localhost/db'),
      ).rejects.toThrow('Unsupported database URI');
    });

    it('pins a sqlite in-memory pool to a single connection', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');

      expect(options.pool).toEqual({min: 1, max: 1});
    });

    it('leaves a file-backed sqlite pool unpinned', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite:///tmp/unpinned.db',
      );

      expect(options.pool).toBeUndefined();
    });

    it('turns sqlite foreign keys on for every connection the pool opens', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');

      expect(options.driverOptions).toEqual({
        pool: {afterCreate: enableSqliteForeignKeys},
      });
    });

    it('probes a non-sqlite connection for liveness before handing it out', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
      );

      expect(options.driverOptions).toEqual({
        pool: {validate: connectionIsAlive},
      });
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

    it('lets an override replace the derived pool settings', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
        {pool: {min: 2, max: 8}, driverOptions: {}},
      );

      expect(options.pool).toEqual({min: 2, max: 8});
      expect(options.driverOptions).toEqual({});
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

  describe('namesSupportedDatabaseBackend', () => {
    it('accepts a supported backend carrying a driver suffix', () => {
      expect(namesSupportedDatabaseBackend('postgresql+asyncpg://h/db')).toBe(
        true,
      );
    });

    it('rejects a backend this service cannot open', () => {
      expect(namesSupportedDatabaseBackend('oracle://h/db')).toBe(false);
    });
  });

  describe('assertSupportedDatabaseUri', () => {
    const password = 'hunter2';

    it('accepts a supported plain URI', () => {
      expect(() =>
        assertSupportedDatabaseUri('sqlite://:memory:'),
      ).not.toThrow();
    });

    it('reports a string that is not a URL, without leaking it', () => {
      expect(() =>
        assertSupportedDatabaseUri(`definitely not a url ${password}`),
      ).toThrow(
        "Invalid database URL format or argument '<unparseable URI, redacted>'.",
      );
    });

    it('reports an unsupported backend with the password masked', () => {
      let message = '';
      try {
        assertSupportedDatabaseUri(`oracle://user:${password}@host:1521/db`);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe(
        'Unsupported database URI: oracle://user:***@host:1521/db',
      );
      expect(message).not.toContain(password);
    });

    it('reports a driver named in the scheme with the password masked', () => {
      let message = '';
      try {
        assertSupportedDatabaseUri(
          `postgresql+asyncpg://user:${password}@db:5432/app`,
        );
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe(
        "Database URL 'postgresql+asyncpg://user:***@db:5432/app' names the " +
          "'asyncpg' driver in its scheme. adk-js selects its own driver, so " +
          "use a 'postgresql://' URL instead.",
      );
      expect(message).not.toContain(password);
    });
  });

  describe('enableSqliteForeignKeys', () => {
    it('runs the foreign-keys pragma and reports the connection back', () => {
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

    it('reports a failing pragma back to the pool', () => {
      const failure = new Error('disk I/O error');
      const connection = {
        run(_sql: string, callback: (error: Error | null) => void) {
          callback(failure);
        },
      };
      const done = vi.fn();

      enableSqliteForeignKeys(connection, done);

      expect(done).toHaveBeenCalledWith(failure, connection);
    });
  });

  describe('connectionIsAlive', () => {
    it('reports a connection that answers the probe as alive', async () => {
      const probed: string[] = [];
      const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
          probed.push(sql);
          callback(null);
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(true);
      expect(probed).toEqual(['select 1']);
    });

    it('reports a connection whose probe errors as dead', async () => {
      const connection = {
        query(_sql: string, callback: (error: Error | null) => void) {
          callback(new Error('server closed the connection'));
        },
      };

      await expect(connectionIsAlive(connection)).resolves.toBe(false);
    });

    it('reports a connection exposing no query method as alive', async () => {
      await expect(connectionIsAlive({})).resolves.toBe(true);
      await expect(connectionIsAlive(undefined)).resolves.toBe(true);
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
});
