/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityManager,
  EntityName,
  FilterQuery,
  MikroORM,
  Options as MikroORMOptions,
  RequiredEntityData,
} from '@mikro-orm/core';
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

const SQLITE_BACKEND = 'sqlite';
const SQLITE_URI_PREFIX = 'sqlite://';
const SQLITE_MEMORY_URI = 'sqlite://:memory:';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

async function loadPostgresDriver(): Promise<unknown> {
  const {PostgreSqlDriver} = await loadOptionalPeer(
    driverPeer('@mikro-orm/postgresql', 'postgres'),
    () => import('@mikro-orm/postgresql'),
  );
  return PostgreSqlDriver;
}

async function loadMySqlDriver(): Promise<unknown> {
  const {MySqlDriver} = await loadOptionalPeer(
    driverPeer('@mikro-orm/mysql', 'mysql'),
    () => import('@mikro-orm/mysql'),
  );
  return MySqlDriver;
}

async function loadMariaDbDriver(): Promise<unknown> {
  const {MariaDbDriver} = await loadOptionalPeer(
    driverPeer('@mikro-orm/mariadb', 'mariadb'),
    () => import('@mikro-orm/mariadb'),
  );
  return MariaDbDriver;
}

async function loadMsSqlDriver(): Promise<unknown> {
  const {MsSqlDriver} = await loadOptionalPeer(
    driverPeer('@mikro-orm/mssql', 'mssql'),
    () => import('@mikro-orm/mssql'),
  );
  return MsSqlDriver;
}

async function loadSqliteDriver(): Promise<unknown> {
  const {SqliteDriver} = await loadOptionalPeer(
    driverPeer('@mikro-orm/sqlite', 'sqlite'),
    () => import('@mikro-orm/sqlite'),
  );
  return SqliteDriver;
}

/** The MikroORM driver each supported URI backend loads. */
const DRIVER_LOADERS: Record<string, () => Promise<unknown>> = {
  postgres: loadPostgresDriver,
  postgresql: loadPostgresDriver,
  mysql: loadMySqlDriver,
  mariadb: loadMariaDbDriver,
  mssql: loadMsSqlDriver,
  [SQLITE_BACKEND]: loadSqliteDriver,
};

/** Why a connection URI is not one this service can open. */
export enum DatabaseUriProblem {
  /** The string carries no URI scheme at all. */
  NOT_A_URI = 'NOT_A_URI',
  /** The scheme names a backend with no driver here, such as `oracle`. */
  UNSUPPORTED_BACKEND = 'UNSUPPORTED_BACKEND',
  /** The scheme names a driver as well, the way SQLAlchemy URLs do. */
  DRIVER_IN_SCHEME = 'DRIVER_IN_SCHEME',
}

/**
 * Splits the scheme of a connection URI into its backend and driver parts.
 *
 * `postgresql+asyncpg://host/db` yields `postgresql` and `asyncpg`. A string
 * carrying no `://` yields an empty backend, which no loader answers to.
 */
function schemeOf(uri: string): {backend: string; driver?: string} {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd <= 0) {
    return {backend: ''};
  }
  const [backend, driver] = uri.slice(0, schemeEnd).split('+');
  return {backend, driver};
}

/**
 * Reports whether a URI names a database backend this service supports.
 *
 * A driver-suffixed scheme counts. Routing such a URI here is what lets the
 * caller hear about the suffix, instead of hearing that the URI belongs to no
 * session service at all.
 *
 * @param uri The database connection URI.
 */
export function namesSupportedDatabaseBackend(uri: string): boolean {
  return Object.hasOwn(DRIVER_LOADERS, schemeOf(uri).backend);
}

/** Returns the problem with a URI, or undefined when it is one we can open. */
function classifyDatabaseUri(uri: string): DatabaseUriProblem | undefined {
  const {backend, driver} = schemeOf(uri);
  if (!backend) {
    return DatabaseUriProblem.NOT_A_URI;
  }
  if (!Object.hasOwn(DRIVER_LOADERS, backend)) {
    return DatabaseUriProblem.UNSUPPORTED_BACKEND;
  }
  if (driver) {
    return DatabaseUriProblem.DRIVER_IN_SCHEME;
  }
  return undefined;
}

/** Builds the message for a rejected URI, with its password masked. */
function describeDatabaseUriProblem(
  uri: string,
  problem: DatabaseUriProblem,
): string {
  const redacted = redactUriPassword(uri);
  switch (problem) {
    case DatabaseUriProblem.NOT_A_URI:
      return `Invalid database URL format or argument '${redacted}'.`;
    case DatabaseUriProblem.UNSUPPORTED_BACKEND:
      return `Unsupported database URI: ${redacted}`;
    case DatabaseUriProblem.DRIVER_IN_SCHEME: {
      const {backend, driver} = schemeOf(uri);
      return (
        `Database URL '${redacted}' names the '${driver}' driver in its ` +
        `scheme. adk-js selects its own driver, so use a '${backend}://' ` +
        'URL instead.'
      );
    }
  }
}

/**
 * Throws unless the URI is one this service can open.
 *
 * @param uri The database connection URI.
 * @throws Error naming what is wrong with the URI, its password masked.
 */
export function assertSupportedDatabaseUri(uri: string): void {
  const problem = classifyDatabaseUri(uri);
  if (problem !== undefined) {
    throw new Error(describeDatabaseUriProblem(uri, problem));
  }
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
  assertSupportedDatabaseUri(uri);
  const {backend} = schemeOf(uri);
  const driver = await DRIVER_LOADERS[backend]();

  if (backend === SQLITE_BACKEND) {
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
 * Returns a stored row, inserting it when it is absent.
 *
 * Two callers can both miss the row and both insert it, and the loser's
 * insert then fails on the primary key. The winner's row is the correct
 * answer, so this reads it back instead of surfacing the driver's constraint
 * error. Dialects report a duplicate key differently, so the row's presence is
 * the evidence rather than the error class. An insert that failed for any
 * other reason still leaves no row, and its error propagates unchanged.
 *
 * The insert runs on its own fork of `em`. MikroORM flushes every pending
 * entity in one transaction, so a shared unit of work would abort the
 * caller's other pending writes along with the losing insert.
 *
 * @param em The entity manager the returned row is managed by.
 * @param entity The entity to read or insert.
 * @param where The filter identifying the row.
 * @param defaults The data to insert when the row is absent.
 */
export async function getOrCreateRow<T extends object>(
  em: EntityManager,
  entity: EntityName<T>,
  where: FilterQuery<T>,
  defaults: RequiredEntityData<T>,
): Promise<T> {
  const existing = await em.findOne(entity, where);
  if (existing) {
    return existing;
  }

  const inserter = em.fork();
  try {
    await inserter.persist(inserter.create(entity, defaults)).flush();
  } catch (error: unknown) {
    const winner = await em.findOne(entity, where);
    if (!winner) {
      throw error;
    }
    return winner;
  }
  return em.findOneOrFail(entity, where);
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
