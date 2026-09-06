/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  EVENTS_TABLE_NAME,
  METADATA_TABLE_NAME,
  SCHEMA_VERSION_0_PICKLE,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

const SQLITE_URI_PREFIX = 'sqlite://';
const SQLITE_MEMORY_URI = 'sqlite://:memory:';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @param overrides Options merged over the ones derived from the URI, so a
 *     caller can configure the pool, the driver or anything else MikroORM
 *     accepts. The last write wins.
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
  overrides?: Partial<MikroORMOptions>,
): Promise<MikroORMOptions> {
  const derived = await deriveConnectionOptionsFromUri(uri);
  return {...derived, ...overrides};
}

async function deriveConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  let driver: unknown;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/postgresql', 'postgres'),
      () => import('@mikro-orm/postgresql'),
    );
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mysql', 'mysql'),
      () => import('@mikro-orm/mysql'),
    );
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    driver = MariaDbDriver;
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/sqlite', 'sqlite'),
      () => import('@mikro-orm/sqlite'),
    );
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mssql', 'mssql'),
      () => import('@mikro-orm/mssql'),
    );
    driver = MsSqlDriver;
  } else {
    throw new Error(`Unsupported database URI: ${redactUriPassword(uri)}`);
  }

  if (uri.startsWith(SQLITE_URI_PREFIX)) {
    const isMemory = uri === SQLITE_MEMORY_URI;
    return {
      entities: ENTITIES,
      dbName: isMemory ? ':memory:' : uri.substring(SQLITE_URI_PREFIX.length),
      driver,
      // Every connection to a SQLite in-memory database opens a separate,
      // empty database, so a pool wider than one connection loses the schema
      // and the rows written through its siblings.
      ...(isMemory ? {pool: {min: 1, max: 1}} : {}),
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
 * Reports whether a `SELECT` over the given columns succeeds.
 *
 * MikroORM's core package exposes no portable schema reflection, so a probe
 * query stands in for one. `where 1 = 0` makes the statement free of rows on
 * every supported dialect, and the identifiers are fixed literals declared in
 * `schema.ts`, never caller input.
 */
async function selectSucceeds(
  orm: MikroORM,
  columns: string,
  table: string,
): Promise<boolean> {
  try {
    await orm.em
      .getConnection()
      .execute(`select ${columns} from ${table} where 1 = 0`, [], 'all');
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects which ADK schema version a database holds.
 *
 * Call this before creating any table: creating the V1 tables adds an
 * `event_data` column to a legacy `events` table, which destroys the evidence
 * this check reads.
 *
 * @param orm The MikroORM instance.
 * @returns The stored schema version, `SCHEMA_VERSION_0_PICKLE` for a legacy
 *     database, or `SCHEMA_VERSION_1_JSON` for an empty one.
 * @throws Error if the metadata table exists but holds no schema version.
 */
export async function detectDatabaseSchemaVersion(
  orm: MikroORM,
): Promise<string> {
  if (await selectSucceeds(orm, '1', METADATA_TABLE_NAME)) {
    const stored = await orm.em
      .fork()
      .findOne(StorageMetadata, {key: SCHEMA_VERSION_KEY});
    if (!stored) {
      throw new Error(
        `Schema version not found in ${METADATA_TABLE_NAME}. The database ` +
          'might be malformed.',
      );
    }
    return stored.value;
  }

  const hasLegacyEventsTable =
    (await selectSucceeds(orm, 'actions', EVENTS_TABLE_NAME)) &&
    !(await selectSucceeds(orm, 'event_data', EVENTS_TABLE_NAME));
  if (hasLegacyEventsTable) {
    logger.warn(
      'The database uses the legacy v0 session schema, which serializes ' +
        'event actions with Python pickle. This SDK cannot read it. Migrate ' +
        'the database with the adk-python `adk migrate session` command.',
    );
    return SCHEMA_VERSION_0_PICKLE;
  }

  return SCHEMA_VERSION_1_JSON;
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
