/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  deleteOrphanedEvents,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
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

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

async function insertEventRow(
  orm: MikroORM,
  id: string,
  sessionId: string,
): Promise<void> {
  await orm.em
    .getConnection()
    .execute(
      'INSERT INTO events (id, app_name, user_id, session_id, invocation_id, timestamp, event_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, APP_NAME, USER_ID, sessionId, `invocation-${id}`, Date.now(), '{}'],
    );
}

async function insertLiveSessionWithEvent(orm: MikroORM): Promise<void> {
  const now = Date.now();
  await orm.em
    .getConnection()
    .execute(
      'INSERT INTO sessions (app_name, user_id, id, state, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?)',
      [APP_NAME, USER_ID, SESSION_ID, '{}', now, now],
    );
  await insertEventRow(orm, 'live-event', SESSION_ID);
}

/**
 * Writes the row shape that a database created before the foreign key can
 * hold: an event whose session was deleted.
 */
async function insertOrphanedEvent(orm: MikroORM): Promise<void> {
  const connection = orm.em.getConnection();
  await connection.execute('pragma foreign_keys = off');
  await insertEventRow(orm, 'orphan-event', 'missing-session');
  await connection.execute('pragma foreign_keys = on');
}

async function countEvents(orm: MikroORM): Promise<number> {
  return orm.em.fork().count(StorageEvent, {});
}

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

      // `session` owns app_name, user_id and session_id, so these two
      // properties emit every key column of the events table.
      const eventProperties = orm.getMetadata().get(StorageEvent.name)
        .properties as Record<string, {length?: number; fieldNames: string[]}>;
      const keyColumnLengths = ['id', 'session'].flatMap((keyProperty) => {
        const property = eventProperties[keyProperty];
        return property.fieldNames.map(() => property.length);
      });

      expect(keyColumnLengths).toEqual(
        Array(4).fill(STORAGE_KEY_COLUMN_LENGTH),
      );

      const utf8mb4KeyBytes = keyColumnLengths.reduce<number>(
        (total, length) => total + (length ?? 0) * 4,
        0,
      );
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

    it('deletes orphaned events and retries when the schema update fails', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });
      await orm.schema.createSchema();
      await insertOrphanedEvent(orm);

      const updateSchema = vi.spyOn(orm.schema, 'updateSchema');
      updateSchema.mockRejectedValueOnce(
        new Error('constraint "events_app_name_user_id_session_id_foreign"'),
      );

      await expect(ensureDatabaseCreated(orm)).resolves.toBeUndefined();

      expect(updateSchema).toHaveBeenCalledTimes(2);
      expect(await countEvents(orm)).toBe(0);
    });

    it('propagates the error when the schema update fails again', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });
      await orm.schema.createSchema();

      const updateSchema = vi.spyOn(orm.schema, 'updateSchema');
      updateSchema.mockRejectedValueOnce(new Error('first failure'));
      updateSchema.mockRejectedValueOnce(new Error('second failure'));

      await expect(ensureDatabaseCreated(orm)).rejects.toThrow(
        'second failure',
      );
    });
  });

  describe('deleteOrphanedEvents', () => {
    let orm: MikroORM;

    afterEach(async () => {
      if (orm) {
        await orm.close();
      }
    });

    it('removes only the events whose session is gone', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });
      await orm.schema.createSchema();
      await insertLiveSessionWithEvent(orm);
      await insertOrphanedEvent(orm);
      expect(await countEvents(orm)).toBe(2);

      await deleteOrphanedEvents(orm);

      const remaining = await orm.em
        .fork()
        .find(StorageEvent, {}, {fields: ['id']});
      expect(remaining.map((event) => event.id)).toEqual(['live-event']);
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
