/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FlushMode, MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {
  isMissingModule,
  loadOptionalPeer,
  OptionalPeer,
} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** A connection URI scheme split into backend and (optional) named driver. */
export interface DatabaseUriScheme {
  /** The backend the URI names, lowercased, empty when there is no scheme. */
  backend: string;
  /** The driver a SQLAlchemy-style `backend+driver://` scheme names. */
  driver?: string;
}

/** Backend name this module normalizes the sqlite dialect to. */
const SQLITE_BACKEND = 'sqlite';

/** Dialect name the sqlite driver reports through knex. */
const SQLITE_KNEX_DIALECT = 'sqlite3';

/** The only sqlite URI that opens a database held in memory. */
const SQLITE_MEMORY_URI = 'sqlite://:memory:';

/** Backends a connection URI may name. */
const SUPPORTED_BACKENDS: ReadonlySet<string> = new Set([
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mssql',
  SQLITE_BACKEND,
]);

/**
 * Backends whose dialect implements `SELECT ... FOR UPDATE`, matching
 * adk-python's `_supports_row_level_locking`.
 */
const ROW_LEVEL_LOCKING_BACKENDS: ReadonlySet<string> = new Set([
  'mariadb',
  'mysql',
  'postgresql',
]);

/** Statement that turns on sqlite's foreign-key enforcement. */
export const SQLITE_FOREIGN_KEYS_PRAGMA = 'PRAGMA foreign_keys = ON';

/** Statement the pool runs to check a connection is still usable. */
export const LIVENESS_PROBE_SQL = 'select 1';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string): OptionalPeer {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

function invalidUrlMessage(uri: string): string {
  return `Invalid database URL format or argument '${redactUriPassword(uri)}'.`;
}

function unsupportedBackendMessage(uri: string): string {
  return `Unsupported database URI: ${redactUriPassword(uri)}`;
}

function namedDriverMessage(
  uri: string,
  backend: string,
  driver: string,
): string {
  return (
    `Database URL '${redactUriPassword(uri)}' names the '${driver}' driver ` +
    `in its scheme. adk-js selects its own driver, so use a ` +
    `'${backend}://' URL instead.`
  );
}

function missingDriverMessage(uri: string): string {
  return `Database related module not found for URL '${redactUriPassword(uri)}'.`;
}

function engineCreationMessage(uri: string): string {
  return `Failed to create database engine for URL '${redactUriPassword(uri)}'`;
}

/**
 * Splits a connection URI into the backend it names and, when the scheme
 * carries a SQLAlchemy-style `+driver` suffix, that driver.
 *
 * @param uri The database connection URI.
 * @returns The parsed scheme. `backend` is empty when `uri` has no `://`.
 */
export function schemeOf(uri: string): DatabaseUriScheme {
  const separator = uri.indexOf('://');
  if (separator === -1) {
    return {backend: ''};
  }

  const [backend, driver] = uri.slice(0, separator).toLowerCase().split('+');
  return driver ? {backend, driver} : {backend};
}

/**
 * Reports whether a URI names a backend this service can open, including when
 * the scheme carries a driver suffix this service cannot use. Such a URI is
 * recognized so that {@link assertSupportedDatabaseUri} can explain it rather
 * than the caller getting a generic routing failure.
 *
 * @param uri The URI to check.
 * @returns True when the scheme names one of the supported backends.
 */
export function namesSupportedDatabaseBackend(uri: string): boolean {
  return SUPPORTED_BACKENDS.has(schemeOf(uri).backend);
}

/**
 * Rejects a connection URI this service cannot open, naming the URI with its
 * password masked.
 *
 * @param uri The database connection URI.
 * @throws Error if the URI has no scheme, names an unsupported backend, or
 *   names a driver in its scheme.
 */
export function assertSupportedDatabaseUri(uri: string): void {
  const {backend, driver} = schemeOf(uri);

  if (!backend) {
    throw new Error(invalidUrlMessage(uri));
  }
  if (!SUPPORTED_BACKENDS.has(backend)) {
    throw new Error(unsupportedBackendMessage(uri));
  }
  if (driver) {
    throw new Error(namedDriverMessage(uri, backend, driver));
  }
}

/** The sqlite driver handle knex hands to its `afterCreate` pool hook. */
export interface SqliteConnectionHandle {
  run(sql: string, callback: (error: Error | null) => void): void;
}

/** knex's callback reporting that an `afterCreate` pool hook finished. */
export type PoolConnectCallback = (
  error: Error | null,
  connection: SqliteConnectionHandle,
) => void;

/**
 * Turns on foreign-key enforcement for one sqlite connection.
 *
 * sqlite reads `foreign_keys` per connection and defaults it off, so every
 * connection the pool opens has to set it again. adk-python installs the same
 * pragma through a SQLAlchemy `connect` listener.
 */
export function enableSqliteForeignKeys(
  connection: SqliteConnectionHandle,
  done: PoolConnectCallback,
): void {
  connection.run(SQLITE_FOREIGN_KEYS_PRAGMA, (error) =>
    done(error, connection),
  );
}

/** The part of a pooled driver connection the liveness probe uses. */
interface QueryableConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
}

function isQueryableConnection(value: unknown): value is QueryableConnection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'query' in value &&
    typeof value.query === 'function'
  );
}

/**
 * Reports whether a pooled connection still answers, so one a firewall or a
 * server restart already dropped is replaced instead of handed to the caller.
 * This is adk-python's `pool_pre_ping`, reached through knex's pool.
 *
 * A connection exposing no callback-style `query` is reported alive and left
 * to knex's own liveness check.
 *
 * @param connection The pooled driver connection knex is about to hand out.
 * @returns True when the connection answered the probe.
 */
export function connectionIsAlive(connection: unknown): Promise<boolean> {
  if (!isQueryableConnection(connection)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    connection.query(LIVENESS_PROBE_SQL, (error) => resolve(!error));
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
 * Returns the backend name the open connection reports, normalized to the
 * names adk-python's SQLAlchemy dialects use.
 *
 * @param orm The initialized MikroORM instance.
 * @returns The backend name, or an empty string for a driver exposing no knex
 *   handle.
 */
export function getDatabaseBackend(orm: MikroORM): string {
  const connection = orm.em.getConnection();
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
export function forkForRead(orm: MikroORM) {
  return orm.em.fork({flushMode: FlushMode.COMMIT});
}

/**
 * Forks an entity manager for a write path.
 *
 * @param orm The initialized MikroORM instance.
 * @returns An entity manager for the write path.
 */
export function forkForWrite(orm: MikroORM) {
  return orm.em.fork();
}

/**
 * Loads a driver package, reporting a missing one against the URI that needs
 * it.
 */
async function loadDriver<T>(
  uri: string,
  peer: OptionalPeer,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await loadOptionalPeer(peer, load);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      isMissingModule(error.cause, peer.packageName)
    ) {
      throw new Error(`${missingDriverMessage(uri)} ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Opens the database, reporting a failure against the URI with its password
 * masked.
 *
 * @param options The MikroORM options to open.
 * @param uri The connection URI the options came from, when there was one. An
 *   options object built by the caller names no URL, so its failure is left
 *   unchanged.
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
    throw new Error(engineCreationMessage(uri), {cause: error});
  }
}

/**
 * Pool settings for a sqlite database.
 *
 * A `:memory:` database lives inside its connection, so a pool wider than one
 * hands out connections onto separate empty databases. adk-python pins the
 * same case with SQLAlchemy's `StaticPool`.
 */
function sqlitePoolOptions(uri: string): Partial<MikroORMOptions> {
  return {
    ...(uri === SQLITE_MEMORY_URI ? {pool: {min: 1, max: 1}} : {}),
    driverOptions: {pool: {afterCreate: enableSqliteForeignKeys}},
  };
}

/** Pool settings for every backend other than sqlite. */
function prePingPoolOptions(): Partial<MikroORMOptions> {
  return {driverOptions: {pool: {validate: connectionIsAlive}}};
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @param overrides Options applied on top of the ones the URI implies, the
 *   equivalent of adk-python's engine keyword arguments.
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
  overrides?: Partial<MikroORMOptions>,
): Promise<MikroORMOptions> {
  let driver: unknown;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await loadDriver(
      uri,
      driverPeer('@mikro-orm/postgresql', 'postgres'),
      () => import('@mikro-orm/postgresql'),
    );
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await loadDriver(
      uri,
      driverPeer('@mikro-orm/mysql', 'mysql'),
      () => import('@mikro-orm/mysql'),
    );
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadDriver(
      uri,
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    driver = MariaDbDriver;
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await loadDriver(
      uri,
      driverPeer('@mikro-orm/sqlite', 'sqlite'),
      () => import('@mikro-orm/sqlite'),
    );
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await loadDriver(
      uri,
      driverPeer('@mikro-orm/mssql', 'mssql'),
      () => import('@mikro-orm/mssql'),
    );
    driver = MsSqlDriver;
  } else {
    throw new Error(unsupportedBackendMessage(uri));
  }

  if (uri.startsWith('sqlite://')) {
    return {
      entities: ENTITIES,
      dbName:
        uri === SQLITE_MEMORY_URI
          ? ':memory:'
          : uri.substring('sqlite://'.length),
      driver,
      ...sqlitePoolOptions(uri),
      ...overrides,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
    ...prePingPoolOptions(),
    ...overrides,
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
