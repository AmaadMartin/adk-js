/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MikroORM,
  Options as MikroORMOptions,
  QueryResult,
} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

const DELETE_ORPHANED_EVENTS_SQL = `DELETE FROM events
WHERE NOT EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.app_name = events.app_name
    AND sessions.user_id = events.user_id
    AND sessions.id = events.session_id
)`;

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  let driver: unknown | undefined;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await import('@mikro-orm/postgresql');
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await import('@mikro-orm/mysql');
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await import('@mikro-orm/mariadb');
    driver = MariaDbDriver;
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await import('@mikro-orm/sqlite');
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await import('@mikro-orm/mssql');
    driver = MsSqlDriver;
  } else {
    throw new Error(`Unsupported database URI: ${uri}`);
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
 * Deletes event rows whose session no longer exists.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function deleteOrphanedEvents(orm: MikroORM): Promise<void> {
  const result: QueryResult = await orm.em
    .getConnection()
    .execute(DELETE_ORPHANED_EVENTS_SQL, [], 'run');
  logger.warn(
    `Deleted ${result.affectedRows} event rows whose session no longer exists.`,
  );
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

  try {
    // creates tables if they don't exist. Safe mode prevents dropping columns or tables.
    await orm.schema.updateSchema({safe: true});
  } catch (error) {
    // A database created before the events -> sessions foreign key can hold
    // event rows whose session is already gone, and the constraint cannot be
    // added while they exist. Those rows are unreachable through the service,
    // so drop them and let the schema update finish.
    logger.warn(
      'Schema update failed; retrying after deleting orphaned events.',
      error,
    );
    await deleteOrphanedEvents(orm);
    await orm.schema.updateSchema({safe: true});
  }
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
