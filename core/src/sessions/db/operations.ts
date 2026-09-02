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

/**
 * The part of a raw sqlite connection the pragma hook uses.
 *
 * knex hands the driver's own connection object to `pool.afterCreate`, and
 * `sqlite3` exposes `run` for a statement that returns no rows.
 */
interface SqliteRawConnection {
  run(sql: string, callback: (error: Error | null) => void): void;
}

/**
 * Turns foreign key enforcement on for one pooled sqlite connection.
 *
 * The constraint it enforces is one adk-python wrote, not one declared here.
 * Both of its schema versions give `events` a composite foreign key to
 * `sessions` with `ON DELETE CASCADE`, while the entities in `schema.ts`
 * declare none. On a database this SDK created the pragma is therefore inert;
 * on one adk-python created it decides whether that cascade runs. Sharing a
 * database between the two SDKs is what this service exists for, so the pragma
 * is set rather than skipped.
 *
 * sqlite reads the pragma per connection and defaults it to off, so each
 * connection needs it. adk-python applies it from SQLAlchemy's `connect`
 * event, for the same reason.
 *
 * @param connection The connection knex has just opened.
 * @param done The callback knex waits on before it hands the connection out.
 */
export function enableSqliteForeignKeys(
  connection: SqliteRawConnection,
  done: (error: Error | null, connection: SqliteRawConnection) => void,
): void {
  connection.run('PRAGMA foreign_keys = ON', (error) =>
    done(error, connection),
  );
}

/** The statement the liveness check sends. Every supported dialect answers it. */
const LIVENESS_PROBE_SQL = 'select 1';

/**
 * The part of a pooled connection the liveness check uses.
 *
 * The drivers behind `postgres`, `mysql` and `mariadb` all take a statement
 * and a callback here.
 */
interface QueryableRawConnection {
  query(sql: string, callback: (error: Error | null) => void): unknown;
}

function isQueryableConnection(
  connection: unknown,
): connection is QueryableRawConnection {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    'query' in connection &&
    typeof connection.query === 'function'
  );
}

/**
 * Reports whether a pooled connection still answers, before the pool hands it
 * out.
 *
 * A server, a proxy or a firewall can drop an idle connection without the
 * client noticing, and the caller then sees the driver's socket error on a
 * statement it did not cause. This is adk-python's `pool_pre_ping=True`, which
 * it sets for every non-sqlite URL, and it costs one round trip per checkout
 * of an already-open connection. Pass `driverOptions` through the service's
 * `overrides` argument to replace or drop it.
 *
 * A driver whose raw connection takes no statement, such as the one behind
 * `mssql`, is left to the liveness check knex makes for its own dialect.
 *
 * @param connection The connection the pool is about to hand out.
 */
export async function connectionIsAlive(connection: unknown): Promise<boolean> {
  if (!isQueryableConnection(connection)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    try {
      connection.query(LIVENESS_PROBE_SQL, (error) => resolve(!error));
    } catch {
      // A driver that rejects the probe synchronously is not usable either.
      resolve(false);
    }
  });
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

/**
 * Says what is wrong with a connection URI, or nothing when it is usable.
 *
 * The three messages match the buckets adk-python distinguishes: a string that
 * is not a URI, a backend with no driver here, and a scheme that names its
 * driver the way a SQLAlchemy URL does. Each one masks the password.
 */
function describeDatabaseUriProblem(uri: string): string | undefined {
  const {backend, driver} = schemeOf(uri);
  if (!backend) {
    return `Invalid database URL format or argument '${redactUriPassword(uri)}'.`;
  }
  if (!Object.hasOwn(DRIVER_LOADERS, backend)) {
    return `Unsupported database URI: ${redactUriPassword(uri)}`;
  }
  if (driver) {
    return (
      `Database URL '${redactUriPassword(uri)}' names the '${driver}' driver ` +
      `in its scheme. adk-js selects its own driver, so use a ` +
      `'${backend}://' URL instead.`
    );
  }
  return undefined;
}

/**
 * Throws unless the URI is one this service can open.
 *
 * @param uri The database connection URI.
 * @throws Error naming what is wrong with the URI, its password masked.
 */
export function assertSupportedDatabaseUri(uri: string): void {
  const problem = describeDatabaseUriProblem(uri);
  if (problem !== undefined) {
    throw new Error(problem);
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
      // knex reaches every connection it opens through this hook, while the
      // `pool` option below stays free for the caller to replace.
      driverOptions: {pool: {afterCreate: enableSqliteForeignKeys}},
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
    // Every backend but sqlite reaches this service over a socket that can be
    // closed while the connection sits idle in the pool.
    driverOptions: {pool: {validate: connectionIsAlive}},
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
        'event actions with Python pickle. This SDK opens it for reading ' +
        'only. Migrate it with the adk-python `adk migrate session` command ' +
        'to write to it.',
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
