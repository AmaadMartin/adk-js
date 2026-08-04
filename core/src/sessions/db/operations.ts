/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {isModuleNotFoundError} from '../../utils/error_utils.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported, or if the dialect driver
 *     it selects is not installed.
 */
export async function getConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  let driver: unknown | undefined;
  let packageName = '';
  let uriScheme = '';

  try {
    if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
      [packageName, uriScheme] = ['@mikro-orm/postgresql', 'postgres://'];
      driver = (await import('@mikro-orm/postgresql')).PostgreSqlDriver;
    } else if (uri.startsWith('mysql://')) {
      [packageName, uriScheme] = ['@mikro-orm/mysql', 'mysql://'];
      driver = (await import('@mikro-orm/mysql')).MySqlDriver;
    } else if (uri.startsWith('mariadb://')) {
      [packageName, uriScheme] = ['@mikro-orm/mariadb', 'mariadb://'];
      driver = (await import('@mikro-orm/mariadb')).MariaDbDriver;
    } else if (uri.startsWith('sqlite://')) {
      [packageName, uriScheme] = ['@mikro-orm/sqlite', 'sqlite://'];
      driver = (await import('@mikro-orm/sqlite')).SqliteDriver;
    } else if (uri.startsWith('mssql://')) {
      [packageName, uriScheme] = ['@mikro-orm/mssql', 'mssql://'];
      driver = (await import('@mikro-orm/mssql')).MsSqlDriver;
    } else {
      throw new Error(`Unsupported database URI: ${uri}`);
    }
  } catch (error: unknown) {
    if (!isModuleNotFoundError(error)) {
      throw error;
    }
    throw new Error(
      `Database driver '${packageName}' is required for ${uriScheme} ` +
        `connection URIs but is not installed. ` +
        `Install it with: npm install ${packageName}`,
      {cause: error},
    );
  }

  if (uri.startsWith('sqlite://')) {
    return {
      entities: ENTITIES,
      dbName:
        uri === 'sqlite://:memory:'
          ? ':memory:'
          : uri.substring('sqlite://'.length),
      driver,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
  } as MikroORMOptions;
}

/**
 * Creates a database and tables if they don't exist.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function ensureDatabaseCreated(orm: MikroORM): Promise<void> {
  // creates database if it doesn't exist
  await orm.schema.ensureDatabase();

  // creates tables if they don't exist. Safe mode prevents dropping columns or tables.
  await orm.schema.updateSchema({safe: true});
}

/**
 * Validates the schema version.
 *
 * @param orm The MikroORM instance.
 * @throws Error if the schema version is not compatible.
 */
export async function validateDatabaseSchemaVersion(orm: MikroORM) {
  const em = orm.em.fork();
  const existing = await em.findOne(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
  });

  if (existing) {
    if (existing.value !== SCHEMA_VERSION_1_JSON) {
      throw new Error(
        `ADK Database schema version ${existing.value} is not compatible.`,
      );
    }
    return;
  }

  const newVersion = em.create(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
    value: SCHEMA_VERSION_1_JSON,
  });

  await em.persist(newVersion).flush();
}
