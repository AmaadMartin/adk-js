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
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  EVENT_ACTIONS_COLUMN_NAME,
  EVENT_DATA_COLUMN_NAME,
  EVENTS_TABLE_NAME,
  METADATA_TABLE_NAME,
  SCHEMA_VERSION_0_PICKLE,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

async function loadPostgreSqlDriver(): Promise<unknown> {
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

/** The database backends adk-js can open, keyed by URI scheme. */
const DRIVER_LOADERS: Record<string, () => Promise<unknown>> = {
  postgres: loadPostgreSqlDriver,
  postgresql: loadPostgreSqlDriver,
  mysql: loadMySqlDriver,
  mariadb: loadMariaDbDriver,
  mssql: loadMsSqlDriver,
  sqlite: loadSqliteDriver,
};

/** The backend, and the driver a SQLAlchemy-style scheme suffix names. */
interface DatabaseUriScheme {
  backend: string;
  driver?: string;
}

/**
 * Splits the scheme of a connection URI into its backend and driver parts.
 *
 * `postgresql+asyncpg://host/db` yields `{backend: 'postgresql', driver:
 * 'asyncpg'}`. A string with no `://` yields an empty backend.
 */
function schemeOf(uri: string): DatabaseUriScheme {
  const separator = uri.indexOf('://');
  if (separator === -1) {
    return {backend: ''};
  }

  const [backend, driver] = uri.slice(0, separator).toLowerCase().split('+', 2);
  return driver ? {backend, driver} : {backend};
}

/** Returns true when the scheme of `uri` names a backend adk-js supports. */
export function namesSupportedDatabaseBackend(uri: string): boolean {
  return Object.hasOwn(DRIVER_LOADERS, schemeOf(uri).backend);
}

/**
 * Throws unless `uri` is a connection URI `DatabaseSessionService` can open.
 *
 * Every message is built with {@link redactUriPassword}, so a password in the
 * URI never reaches a log or an error report.
 */
export function assertSupportedDatabaseUri(uri: string): void {
  const {backend, driver} = schemeOf(uri);
  const redacted = redactUriPassword(uri);

  if (!backend) {
    throw new Error(`Invalid database URL format or argument '${redacted}'.`);
  }

  if (!Object.hasOwn(DRIVER_LOADERS, backend)) {
    throw new Error(`Unsupported database URI: ${redacted}`);
  }

  if (driver) {
    throw new Error(
      `Database URL '${redacted}' names the '${driver}' driver in its scheme.` +
        ` adk-js selects its own driver, so use a '${backend}://' URL instead.`,
    );
  }
}

/** The part of a raw sqlite connection the foreign-key pragma needs. */
interface SqliteRawConnection {
  run(sql: string, callback: (error: Error | null) => void): void;
}

/** The part of a raw pooled connection the liveness probe needs. */
interface QueryableRawConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
}

function isQueryable(
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
 * Turns foreign-key enforcement on for a freshly opened sqlite connection.
 *
 * sqlite reads `foreign_keys` per connection and defaults it off, so the
 * `events -> sessions ON DELETE CASCADE` constraint adk-python declares does
 * not fire without this. Installed as knex's `pool.afterCreate` hook, which
 * runs for every connection the pool opens rather than only the first.
 */
export function enableSqliteForeignKeys(
  connection: SqliteRawConnection,
  done: (error: Error | null, connection: SqliteRawConnection) => void,
): void {
  connection.run('PRAGMA foreign_keys = ON', (error) =>
    done(error, connection),
  );
}

/**
 * Reports whether a pooled connection still answers, before it is handed out.
 *
 * This is adk-python's `pool_pre_ping`, so an idle connection a firewall
 * dropped is replaced rather than surfacing the driver's socket error. A
 * connection with no `query` method — the `mssql` driver — is reported alive
 * and left to knex's own check.
 */
export async function connectionIsAlive(connection: unknown): Promise<boolean> {
  if (!isQueryable(connection)) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    try {
      connection.query('select 1', (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @param overrides Options applied on top of the derived ones.
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

  if (backend !== 'sqlite') {
    return {
      entities: ENTITIES,
      clientUrl: uri,
      driver,
      driverOptions: {pool: {validate: connectionIsAlive}},
    } as MikroORMOptions;
  }

  const isMemory = uri === 'sqlite://:memory:';
  const options = {
    entities: ENTITIES,
    dbName: isMemory ? ':memory:' : uri.substring('sqlite://'.length),
    driver,
    driverOptions: {pool: {afterCreate: enableSqliteForeignKeys}},
  } as MikroORMOptions;

  if (isMemory) {
    // Every connection to a sqlite in-memory database opens a separate, empty
    // database, so a wider pool loses the schema and the rows its siblings
    // wrote. This is adk-python's `poolclass=StaticPool`.
    options.pool = {min: 1, max: 1};
  }

  return options;
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
 * Runs a probe statement that selects no rows, and reports whether it ran.
 *
 * `select` is the cheapest portable way to ask whether a table or a column
 * exists. `columns` and `table` are fixed literals declared in `schema.ts`,
 * never caller input.
 */
async function probeSelects(
  orm: MikroORM,
  columns: string,
  table: string,
): Promise<boolean> {
  try {
    await orm.em
      .getConnection()
      .execute(`select ${columns} from ${table} where 1 = 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports which schema layout an existing database uses.
 *
 * A database carrying the metadata table answers with the version it records.
 * Otherwise an `events` table with an `actions` column but no `event_data`
 * column is the legacy layout adk-python wrote before v1. Anything else, an
 * empty database included, is reported as the current layout.
 *
 * @throws Error if the metadata table exists but records no version.
 */
export async function detectDatabaseSchemaVersion(
  orm: MikroORM,
): Promise<string> {
  if (await probeSelects(orm, '1', METADATA_TABLE_NAME)) {
    const em = orm.em.fork();
    const recorded = await em.findOne(StorageMetadata, {
      key: SCHEMA_VERSION_KEY,
    });
    if (!recorded) {
      throw new Error(
        `Schema version not found in ${METADATA_TABLE_NAME}. The database might be malformed.`,
      );
    }
    return recorded.value;
  }

  const hasActions = await probeSelects(
    orm,
    EVENT_ACTIONS_COLUMN_NAME,
    EVENTS_TABLE_NAME,
  );
  const hasEventData = await probeSelects(
    orm,
    EVENT_DATA_COLUMN_NAME,
    EVENTS_TABLE_NAME,
  );

  if (hasActions && !hasEventData) {
    return SCHEMA_VERSION_0_PICKLE;
  }

  return SCHEMA_VERSION_1_JSON;
}

/**
 * Returns the row matching `where`, inserting one from `defaults` if absent.
 *
 * Mirrors adk-python's `_get_or_create_state`. Two callers can reach a brand
 * new `(appName, userId)` pair at the same time, and both must succeed.
 *
 * The insert runs on a fork of `em` because MikroORM flushes every pending
 * entity of a unit of work in one transaction: a losing insert on the
 * caller's own entity manager would abort the caller's other pending writes
 * with it. adk-python buys the same isolation with a SAVEPOINT. Evidence —
 * the row being present on re-read — decides the race, because each dialect
 * reports a duplicate key differently.
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
  } catch (error) {
    const winner = await em.findOne(entity, where);
    if (!winner) {
      throw error;
    }
    return winner;
  }

  return em.findOneOrFail(entity, where);
}
