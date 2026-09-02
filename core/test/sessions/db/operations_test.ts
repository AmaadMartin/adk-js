/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
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
