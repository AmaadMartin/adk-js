/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityManager,
  EntityName,
  FilterQuery,
  FlushMode,
  MikroORM,
  Options as MikroORMOptions,
  RequiredEntityData,
} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {
  loadOptionalPeer,
  MissingOptionalPeerError,
} from '../../utils/optional_peer.js';
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

const SQLITE_BACKEND = 'sqlite';
/** Prefix that introduces a sqlite connection string. */
const SQLITE_URI_PREFIX = 'sqlite://';
/** The path a sqlite connection string uses to name an in-memory database. */
const SQLITE_MEMORY_DB_NAME = ':memory:';
/** Dialect name the sqlite driver reports through knex. */
const SQLITE_KNEX_DIALECT = 'sqlite3';

/**
 * Backends whose dialect implements `SELECT ... FOR UPDATE`, matching
 * adk-python's `_supports_row_level_locking`. `postgres` is the second
 * spelling an adk-js connection URL may use for the same backend, not a
 * second SQLAlchemy dialect.
 */
const ROW_LEVEL_LOCKING_BACKENDS: ReadonlySet<string> = new Set([
  'mariadb',
  'mysql',
  'postgres',
  'postgresql',
]);

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

/** The backend, and the driver a SQLAlchemy-style scheme suffix names. */
interface DatabaseUriScheme {
  backend: string;
  driver?: string;
}

/**
 * Splits the scheme of a connection URI into its backend and driver parts.
 *
 * `postgresql+asyncpg://host/db` yields `postgresql` and `asyncpg`. A string
 * carrying no `://` yields an empty backend, which no loader answers to. The
 * scheme is lowercased, so `POSTGRES://host/db` names the same backend.
 */
export function schemeOf(uri: string): DatabaseUriScheme {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd <= 0) {
    return {backend: ''};
  }
  const [backend, driver] = uri.slice(0, schemeEnd).toLowerCase().split('+');
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

/** A sqlite connection string split into the parts the driver needs. */
export interface SqliteUriParts {
  /** Path of the database file, or `:memory:`. */
  dbName: string;
  /** Query string that configures the connection, without its leading `?`. */
  query: string;
}

/**
 * Splits a sqlite connection string into its path and its query string.
 *
 * Everything between `sqlite://` and a `?` is the path, verbatim. adk-js does
 * not follow SQLAlchemy's rule that `sqlite:///x.db` is relative and
 * `sqlite:////x.db` is absolute, so an existing database keeps resolving to
 * the file it resolves to today.
 *
 * A query string configures the connection instead of becoming part of the
 * file name, which is what adk-python's `_parse_db_path` does. The path is
 * percent-decoded only when a query string is present, so a URL without one
 * is unchanged.
 */
export function parseSqliteUri(uri: string): SqliteUriParts {
  const rest = uri.substring(SQLITE_URI_PREFIX.length);
  const queryStart = rest.indexOf('?');
  if (queryStart < 0) {
    return {dbName: rest, query: ''};
  }
  return {
    dbName: decodeURIComponent(rest.slice(0, queryStart)),
    query: rest.slice(queryStart + 1),
  };
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

/** The part of a MikroORM SQL connection that reports the active dialect. */
interface KnexBackedConnection {
  getKnex(): {client?: {dialect?: unknown}};
}

function isKnexBackedConnection(value: object): value is KnexBackedConnection {
  return 'getKnex' in value && typeof value.getKnex === 'function';
}

/**
 * Returns the backend name a driver connection reports, normalized to the
 * names adk-python's SQLAlchemy dialects use.
 *
 * @param connection The driver connection to read the dialect from.
 * @returns The backend name, or an empty string for a connection exposing no
 *     knex handle and for one naming no dialect.
 */
export function dialectOf(connection: object): string {
  if (!isKnexBackedConnection(connection)) {
    return '';
  }

  const dialect = connection.getKnex().client?.dialect;
  if (typeof dialect !== 'string') {
    return '';
  }
  return dialect === SQLITE_KNEX_DIALECT ? SQLITE_BACKEND : dialect;
}

/**
 * Returns the backend name the open database reports.
 *
 * @param orm The initialized MikroORM instance.
 * @returns The backend name, as {@link dialectOf} normalizes it.
 */
export function getDatabaseBackend(orm: MikroORM): string {
  return dialectOf(orm.em.getConnection());
}

/**
 * Reports whether a backend implements `SELECT ... FOR UPDATE`.
 *
 * sqlite compiles the clause away and mssql turns it into a table hint, so
 * neither is asked for a row-level lock.
 *
 * @param backend The backend name, as {@link getDatabaseBackend} returns it.
 * @returns True when the backend takes a row-level write lock.
 */
export function supportsRowLevelLocking(backend: string): boolean {
  return ROW_LEVEL_LOCKING_BACKENDS.has(backend);
}

/**
 * Forks an entity manager for a read path.
 *
 * The fork is its own unit of work, and `FlushMode.COMMIT` stops it flushing
 * outside a transaction, so a read cannot write through it. adk-python binds
 * a `read_only=True` engine here; MikroORM offers no equivalent execution
 * option, so this is a fork that cannot flush rather than a read-only
 * connection.
 *
 * @param orm The initialized MikroORM instance.
 * @returns An entity manager for the read path.
 */
export function forkForRead(orm: MikroORM): EntityManager {
  return orm.em.fork({flushMode: FlushMode.COMMIT});
}

/**
 * Forks an entity manager for a write path.
 *
 * @param orm The initialized MikroORM instance.
 * @returns An entity manager for the write path.
 */
export function forkForWrite(orm: MikroORM): EntityManager {
  return orm.em.fork();
}

/**
 * Opens the database, reporting a failure against the URI with its password
 * masked.
 *
 * @param options The MikroORM options to open.
 * @param uri The connection URI the options came from, when there was one. An
 *     options object built by the caller names no URL, so its failure is left
 *     unchanged.
 * @returns The initialized MikroORM instance.
 */
export async function openDatabaseOrm(
  options: MikroORMOptions,
  uri?: string,
): Promise<MikroORM> {
  try {
    return await MikroORM.init(options);
  } catch (error: unknown) {
    if (uri === undefined) {
      throw error;
    }
    throw new Error(
      `Failed to create database engine for URL '${redactUriPassword(uri)}'`,
      {cause: error},
    );
  }
}

/**
 * Loads the driver package a backend needs, reporting a missing one against
 * the URI that needs it.
 */
async function loadDriverForUri(
  uri: string,
  backend: string,
): Promise<unknown> {
  try {
    return await DRIVER_LOADERS[backend]();
  } catch (error: unknown) {
    // `loadOptionalPeer` raises this type only for a package that is not
    // installed, and rethrows every other load failure unchanged.
    if (error instanceof MissingOptionalPeerError) {
      throw new Error(
        `Database related module not found for URL ` +
          `'${redactUriPassword(uri)}'. ${error.message}`,
        {cause: error},
      );
    }
    throw error;
  }
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * Every backend adk-js supports stores a timestamp in a column that drops the
 * zone, so `forceUtcTimezone` keeps the stored wall clock on UTC instead of
 * the Node process's local zone, and makes MikroORM read a zone-less string
 * back as UTC. adk-python reaches the same result by stripping `tzinfo` before
 * it stores.
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
  const driver = await loadDriverForUri(uri, backend);

  if (backend === SQLITE_BACKEND) {
    const {dbName, query} = parseSqliteUri(uri);
    const isMemory = dbName === SQLITE_MEMORY_DB_NAME;
    return {
      entities: ENTITIES,
      dbName,
      driver,
      driverOptions: {
        // knex reaches every connection it opens through this hook, while the
        // `pool` option below stays free for the caller to replace.
        pool: {afterCreate: enableSqliteForeignKeys},
        // A query string only reaches sqlite through a `file:` name, and
        // sqlite only reads that name as a URI under `OPEN_URI`. sqlite
        // validates the parameters it knows, `mode` among them, and ignores
        // the rest — the same contract adk-python gets from `uri=True`.
        ...(query
          ? {
              connection: {
                filename: `file:${dbName}?${query}`,
                flags: ['OPEN_URI'],
              },
            }
          : {}),
      },
      // Every connection to a SQLite in-memory database opens a separate,
      // empty database, so a pool wider than one connection loses the schema
      // and the rows written through its siblings. This is adk-python's
      // `poolclass=StaticPool`.
      ...(isMemory ? {pool: {min: 1, max: 1}} : {}),
      forceUtcTimezone: true,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
    // Every backend but sqlite reaches this service over a socket that can be
    // closed while the connection sits idle in the pool.
    driverOptions: {pool: {validate: connectionIsAlive}},
    forceUtcTimezone: true,
  } as MikroORMOptions;
}

/** An `alter table ... add constraint ... foreign key` statement. */
const ADD_FOREIGN_KEY = /\badd constraint\b.*\bforeign key\b/i;

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
 * Statements run one at a time so that a foreign key can be skipped on its
 * own. MikroORM otherwise sends every change to one table as a single query,
 * and a rejected foreign key would take the column and index changes with it.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function ensureDatabaseCreated(orm: MikroORM): Promise<void> {
  // creates database if it doesn't exist
  await orm.schema.ensureDatabase();

  // creates tables if they don't exist. Safe mode prevents dropping columns or tables.
  const sql = await orm.schema.getUpdateSchemaSQL({safe: true});

  // sqlite rebuilds a table whose column type changed, and puts the closing
  // `pragma foreign_keys = on;` in front of the statement that follows it. The
  // break after every terminator gives that statement its own line, so it runs
  // instead of being dropped as the tail of the pragma.
  const statements = sql
    .replaceAll(';', ';\n')
    .split('\n')
    .filter((line) => line.trim());

  for (const statement of statements) {
    if (ADD_FOREIGN_KEY.test(statement)) {
      await addForeignKeyIfAccepted(orm, statement);
    } else {
      await orm.schema.execute(statement);
    }
  }
}

/**
 * Adds a foreign key, and continues without it if the database refuses.
 *
 * A table older than the constraint can already hold rows that break it, and
 * the engine then rejects the whole statement. adk-python never adds a
 * constraint to a table that exists, so a database it created is in the same
 * position. The constraint only governs writes from now on, so refusing to
 * open the database over it would cost more than going without it.
 */
async function addForeignKeyIfAccepted(
  orm: MikroORM,
  statement: string,
): Promise<void> {
  try {
    await orm.schema.execute(statement);
  } catch (error) {
    logger.warn(
      `The database did not accept a foreign key on an existing table, and ` +
        `ADK left it off: ${error instanceof Error ? error.message : error}`,
    );
  }
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
    (await selectSucceeds(orm, EVENT_ACTIONS_COLUMN_NAME, EVENTS_TABLE_NAME)) &&
    !(await selectSucceeds(orm, EVENT_DATA_COLUMN_NAME, EVENTS_TABLE_NAME));
  if (hasLegacyEventsTable) {
    logger.warn(
      'The database uses the legacy v0 session schema, which serializes ' +
        'event actions with Python pickle. That schema will not be supported ' +
        'going forward. Migrate to the v1 schema, which serializes event ' +
        'data as JSON, with the adk-python `adk migrate session` command.',
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
  const em = forkForWrite(orm);
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
