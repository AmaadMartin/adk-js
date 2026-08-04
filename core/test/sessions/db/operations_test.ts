/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
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

const HOISTED_DRIVER_MOCKS: ReadonlyArray<readonly [string, string]> = [
  ['@mikro-orm/postgresql', 'PostgreSqlDriver'],
  ['@mikro-orm/mysql', 'MySqlDriver'],
  ['@mikro-orm/mariadb', 'MariaDbDriver'],
  ['@mikro-orm/mssql', 'MsSqlDriver'],
];

function moduleNotFoundError(packageName: string): Error {
  return Object.assign(new Error(`Cannot find package '${packageName}'`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

/**
 * Raises `error` from the mocked namespace's driver getter rather than from the
 * `vi.doMock` factory: Vitest replaces an error thrown by a factory with its own
 * "error when mocking a module" error, which would not carry the resolution code.
 */
function mockDriverImportFailure(
  packageName: string,
  exportName: string,
  error: Error,
): void {
  vi.doMock(packageName, () => ({
    get [exportName]() {
      throw error;
    },
  }));
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

    describe('missing driver packages', () => {
      afterEach(() => {
        for (const [packageName, exportName] of HOISTED_DRIVER_MOCKS) {
          vi.doMock(packageName, () => ({[exportName]: class MockDriver {}}));
        }
        vi.doUnmock('@mikro-orm/sqlite');
      });

      it.each([
        [
          'postgres://user:pass@localhost:5432/db',
          '@mikro-orm/postgresql',
          'PostgreSqlDriver',
          'postgres://',
        ],
        [
          'mysql://user:pass@localhost:3306/db',
          '@mikro-orm/mysql',
          'MySqlDriver',
          'mysql://',
        ],
        [
          'mariadb://user:pass@localhost:3306/db',
          '@mikro-orm/mariadb',
          'MariaDbDriver',
          'mariadb://',
        ],
        [
          'sqlite:///tmp/test.db',
          '@mikro-orm/sqlite',
          'SqliteDriver',
          'sqlite://',
        ],
        [
          'mssql://user:pass@localhost:1433/db',
          '@mikro-orm/mssql',
          'MsSqlDriver',
          'mssql://',
        ],
      ])(
        'reports the install command for %s',
        async (uri, packageName, exportName, schemeLabel) => {
          mockDriverImportFailure(
            packageName,
            exportName,
            moduleNotFoundError(packageName),
          );

          await expect(getConnectionOptionsFromUri(uri)).rejects.toThrow(
            `Database driver '${packageName}' is required for ${schemeLabel} ` +
              `connection URIs but is not installed. ` +
              `Install it with: npm install ${packageName}`,
          );
        },
      );

      it('labels a postgresql:// URI with the canonical postgres:// scheme', async () => {
        mockDriverImportFailure(
          '@mikro-orm/postgresql',
          'PostgreSqlDriver',
          moduleNotFoundError('@mikro-orm/postgresql'),
        );

        await expect(
          getConnectionOptionsFromUri(
            'postgresql://user:pass@localhost:5432/db',
          ),
        ).rejects.toThrow(
          "Database driver '@mikro-orm/postgresql' is required for postgres:// " +
            'connection URIs but is not installed. ' +
            'Install it with: npm install @mikro-orm/postgresql',
        );
      });

      it('preserves the original resolution error as the cause', async () => {
        const original = moduleNotFoundError('@mikro-orm/postgresql');
        mockDriverImportFailure(
          '@mikro-orm/postgresql',
          'PostgreSqlDriver',
          original,
        );

        await expect(
          getConnectionOptionsFromUri('postgres://user:pass@localhost:5432/db'),
        ).rejects.toThrowError(expect.objectContaining({cause: original}));
      });

      it('propagates a non-resolution driver failure unchanged', async () => {
        const original = new Error('driver failed during module evaluation');
        mockDriverImportFailure(
          '@mikro-orm/postgresql',
          'PostgreSqlDriver',
          original,
        );

        const rejection = getConnectionOptionsFromUri(
          'postgres://user:pass@localhost:5432/db',
        );
        await expect(rejection).rejects.toBe(original);
        await expect(rejection).rejects.toThrow(
          'driver failed during module evaluation',
        );
        await expect(rejection).rejects.not.toThrow(/npm install/);
      });

      it('never leaks the connection URI credentials into the message', async () => {
        mockDriverImportFailure(
          '@mikro-orm/postgresql',
          'PostgreSqlDriver',
          moduleNotFoundError('@mikro-orm/postgresql'),
        );

        await expect(
          getConnectionOptionsFromUri(
            // secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string
            'postgres://user:hunter2@localhost:5432/db',
          ),
        ).rejects.toThrowError(
          expect.objectContaining({
            message: expect.not.stringContaining('hunter2'),
          }),
        );
      });
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
