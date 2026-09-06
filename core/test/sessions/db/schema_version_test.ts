/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {upgradeSessionDatabaseSchema} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ENTITIES,
  StorageMetadata,
  StorageSession,
} from '../../../src/sessions/db/schema.js';
import {
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  stampSchemaVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/schema_version.js';

const INCOMPATIBLE_VERSION = '999';

describe('schema_version', () => {
  describe('constants', () => {
    it('accepts the version it stamps', () => {
      expect(SUPPORTED_SCHEMA_VERSIONS.has(LATEST_SCHEMA_VERSION)).toBe(true);
    });

    it('pins the metadata row shared with adk-python', () => {
      expect(SCHEMA_VERSION_KEY).toBe('schema_version');
      expect(SCHEMA_VERSION_1_JSON).toBe('1');
    });
  });

  describe('against an open database', () => {
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

    async function metadataRows(): Promise<StorageMetadata[]> {
      return orm.em.fork().find(StorageMetadata, {});
    }

    describe('readSchemaVersion', () => {
      it('resolves undefined when the version row is absent', async () => {
        await expect(readSchemaVersion(orm)).resolves.toBeUndefined();
      });
    });

    describe('stampSchemaVersion', () => {
      it('stores a version that readSchemaVersion reads back', async () => {
        await stampSchemaVersion(orm, SCHEMA_VERSION_1_JSON);

        await expect(readSchemaVersion(orm)).resolves.toBe(
          SCHEMA_VERSION_1_JSON,
        );
        expect(await metadataRows()).toHaveLength(1);
      });

      it('replaces the stored value instead of adding a row', async () => {
        await stampSchemaVersion(orm, '1');
        await stampSchemaVersion(orm, '2');

        const rows = await metadataRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].value).toBe('2');
      });
    });

    describe('validateDatabaseSchemaVersion', () => {
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

      it('names the accepted versions and the upgrade step when it throws', async () => {
        const em = orm.em.fork();
        await em
          .persist(
            em.create(StorageMetadata, {
              key: SCHEMA_VERSION_KEY,
              value: INCOMPATIBLE_VERSION,
            }),
          )
          .flush();

        await expect(validateDatabaseSchemaVersion(orm)).rejects.toThrow(
          /supports schema version\(s\) 1\..*upgradeSessionDatabaseSchema\(\)/s,
        );
      });

      it('keeps a single version row when called twice', async () => {
        await validateDatabaseSchemaVersion(orm);
        await validateDatabaseSchemaVersion(orm);

        expect(await metadataRows()).toHaveLength(1);
      });
    });
  });

  describe('upgradeSessionDatabaseSchema', () => {
    let directory: string;
    let dbPath: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'adk-schema-version-'));
      dbPath = join(directory, 'sessions.db');
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(directory, {recursive: true, force: true});
    });

    function openDatabase(): Promise<MikroORM> {
      return MikroORM.init({
        dbName: dbPath,
        driver: SqliteDriver,
        entities: ENTITIES,
      });
    }

    async function readDatabase<T>(
      read: (orm: MikroORM) => Promise<T>,
    ): Promise<T> {
      const orm = await openDatabase();
      try {
        return await read(orm);
      } finally {
        await orm.close();
      }
    }

    async function seedVersion(version: string): Promise<void> {
      const orm = await openDatabase();
      try {
        await orm.schema.updateSchema();
        const em = orm.em.fork();
        await em
          .persist(
            em.create(StorageMetadata, {
              key: SCHEMA_VERSION_KEY,
              value: version,
            }),
          )
          .flush();
      } finally {
        await orm.close();
      }
    }

    function storedVersions(): Promise<StorageMetadata[]> {
      return readDatabase((orm) => orm.em.fork().find(StorageMetadata, {}));
    }

    it('creates the tables and stamps a database that does not exist yet', async () => {
      await upgradeSessionDatabaseSchema(`sqlite://${dbPath}`);

      const rows = await storedVersions();
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe(SCHEMA_VERSION_KEY);
      expect(rows[0].value).toBe(LATEST_SCHEMA_VERSION);
      await expect(
        readDatabase((orm) => orm.em.fork().find(StorageSession, {})),
      ).resolves.toEqual([]);
    });

    it('leaves a database that is already at the latest version untouched', async () => {
      await upgradeSessionDatabaseSchema(`sqlite://${dbPath}`);
      await upgradeSessionDatabaseSchema(`sqlite://${dbPath}`);

      const rows = await storedVersions();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(LATEST_SCHEMA_VERSION);
    });

    it('rejects a version outside the accepted set', async () => {
      await seedVersion(INCOMPATIBLE_VERSION);

      await expect(
        upgradeSessionDatabaseSchema(`sqlite://${dbPath}`),
      ).rejects.toThrow(
        `ADK Database schema version ${INCOMPATIBLE_VERSION} is not compatible`,
      );
      const rows = await storedVersions();
      expect(rows[0].value).toBe(INCOMPATIBLE_VERSION);
    });

    it('accepts an options object carrying a driver', async () => {
      await upgradeSessionDatabaseSchema({
        dbName: dbPath,
        driver: SqliteDriver,
      });

      const rows = await storedVersions();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(LATEST_SCHEMA_VERSION);
    });

    it('rejects an options object without a driver', async () => {
      await expect(
        upgradeSessionDatabaseSchema({dbName: dbPath}),
      ).rejects.toThrow('Driver is required when passing options object.');
    });

    it('closes the connection when the stored version is rejected', async () => {
      await seedVersion(INCOMPATIBLE_VERSION);
      const orm = await openDatabase();
      const close = vi.spyOn(orm, 'close');
      vi.spyOn(MikroORM, 'init').mockResolvedValue(orm);

      await expect(
        upgradeSessionDatabaseSchema(`sqlite://${dbPath}`),
      ).rejects.toThrow('is not compatible');

      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
