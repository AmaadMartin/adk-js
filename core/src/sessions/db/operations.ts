/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityClass,
  EntityData,
  EntityManager,
  FilterQuery,
  MikroORM,
  Options as MikroORMOptions,
} from '@mikro-orm/core';
import {redactUriPassword} from '../../utils/redact_uri.js';
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
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  let driver: unknown;

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
    throw new Error(`Unsupported database URI: ${redactUriPassword(uri)}`);
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

/**
 * Returns the state row matching `where`, inserting `data` when it is missing.
 *
 * Two callers can both read a missing row and both insert it, which breaks the
 * loser's whole unit of work with a primary-key violation. The insert is
 * therefore conflict-tolerant, and the row is re-read afterwards so the loser
 * works with the winner's values instead of the empty row it tried to write.
 *
 * @param em The entity manager to read and write through.
 * @param entity The entity class to load.
 * @param where The primary-key filter identifying the row.
 * @param data The row to insert when `where` matches nothing.
 * @returns The managed row, holding the values that are in the database.
 */
export async function getOrCreateStateRow<T extends object>(
  em: EntityManager,
  entity: EntityClass<T>,
  where: FilterQuery<T>,
  data: EntityData<T>,
): Promise<T> {
  const existing = await em.findOne(entity, where);
  if (existing) {
    return existing;
  }

  await em.upsert(entity, data, {onConflictAction: 'ignore'});

  // `refresh` re-hydrates the identity-map entity from the winner's row. Without
  // it the entity keeps the values the ignored insert carried, and the next
  // flush writes them over the winner's row.
  const row = await em.findOne(entity, where, {refresh: true});
  if (!row) {
    throw new Error(`Failed to load the ${entity.name} row after insert.`);
  }
  return row;
}
