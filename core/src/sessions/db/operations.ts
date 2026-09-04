/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FlushMode, MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {
  loadOptionalPeer,
  MissingOptionalPeerError,
} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** A connection URI scheme split into backend and (optional) named driver. */
interface DatabaseUriScheme {
  /** The backend the URI names, lowercased, empty when there is no scheme. */
  backend: string;
  /** The driver a SQLAlchemy-style `backend+driver://` scheme names. */
  driver?: string;
}

/** The optional driver package backing one backend. */
interface DatabaseDriverPeer {
  packageName: string;
  load(): Promise<MikroORMOptions['driver']>;
}

/** Separates the scheme from the rest of a connection URI. */
const SCHEME_SEPARATOR = '://';

/** Backend name this module normalizes the sqlite dialect to. */
const SQLITE_BACKEND = 'sqlite';

/**
 * The driver package each supported backend needs. Every `import()` keeps its
 * specifier literal so that bundlers and `vi.mock` still see it.
 */
const DRIVER_PEERS: Readonly<Record<string, DatabaseDriverPeer>> = {
  postgres: {
    packageName: '@mikro-orm/postgresql',
    load: async () => (await import('@mikro-orm/postgresql')).PostgreSqlDriver,
  },
  postgresql: {
    packageName: '@mikro-orm/postgresql',
    load: async () => (await import('@mikro-orm/postgresql')).PostgreSqlDriver,
  },
  mysql: {
    packageName: '@mikro-orm/mysql',
    load: async () => (await import('@mikro-orm/mysql')).MySqlDriver,
  },
  mariadb: {
    packageName: '@mikro-orm/mariadb',
    load: async () => (await import('@mikro-orm/mariadb')).MariaDbDriver,
  },
  mssql: {
    packageName: '@mikro-orm/mssql',
    load: async () => (await import('@mikro-orm/mssql')).MsSqlDriver,
  },
  [SQLITE_BACKEND]: {
    packageName: '@mikro-orm/sqlite',
    load: async () => (await import('@mikro-orm/sqlite')).SqliteDriver,
  },
};

/** Backends a connection URI may name. */
const SUPPORTED_BACKENDS: ReadonlySet<string> = new Set(
  Object.keys(DRIVER_PEERS),
);

/**
 * Backends whose dialect implements `SELECT ... FOR UPDATE`, matching
 * adk-python's `_supports_row_level_locking`.
 */
const ROW_LEVEL_LOCKING_BACKENDS: ReadonlySet<string> = new Set([
  'mariadb',
  'mysql',
  'postgresql',
]);

/**
 * Splits a connection URI into the backend it names and, when the scheme
 * carries a SQLAlchemy-style `+driver` suffix, that driver.
 *
 * @param uri The database connection URI.
 * @returns The parsed scheme. `backend` is empty when `uri` has no `://`.
 */
export function schemeOf(uri: string): DatabaseUriScheme {
  const separator = uri.indexOf(SCHEME_SEPARATOR);
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
  const redacted = redactUriPassword(uri);

  if (!backend) {
    throw new Error(`Invalid database URL format or argument '${redacted}'.`);
  }
  if (!SUPPORTED_BACKENDS.has(backend)) {
    throw new Error(`Unsupported database URI: ${redacted}`);
  }
  if (driver) {
    throw new Error(
      `Database URL '${redacted}' names the '${driver}' driver in its ` +
        `scheme. adk-js selects its own driver, so use a '${backend}://' ` +
        `URL instead.`,
    );
  }
}

/** The sqlite driver handle knex hands to its `afterCreate` pool hook. */
export interface SqliteConnectionHandle {
  run(sql: string, callback: (error: Error | null) => void): void;
}

/** knex's callback reporting that an `afterCreate` pool hook finished. */
type PoolConnectCallback = (
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
  connection.run('PRAGMA foreign_keys = ON', (error) =>
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
    connection.query('select 1', (error) => resolve(!error));
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
 *   knex handle and for one naming no dialect.
 */
export function dialectOf(connection: object): string {
  if (!isKnexBackedConnection(connection)) {
    return '';
  }

  const dialect = connection.getKnex().client?.dialect;
  if (typeof dialect !== 'string') {
    return '';
  }
  return dialect === 'sqlite3' ? SQLITE_BACKEND : dialect;
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
 * Loads the driver package a backend needs, reporting a missing one against
 * the URI that needs it.
 */
async function loadDriver(
  uri: string,
  backend: string,
  peer: DatabaseDriverPeer,
): Promise<MikroORMOptions['driver']> {
  try {
    return await loadOptionalPeer(
      {
        packageName: peer.packageName,
        feature: `DatabaseSessionService with a "${backend}" connection string`,
      },
      peer.load,
    );
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
    throw new Error(
      `Failed to create database engine for URL '${redactUriPassword(uri)}'`,
      {cause: error},
    );
  }
}

/**
 * Pool settings for a sqlite database.
 *
 * A `:memory:` database lives inside its connection, so a pool wider than one
 * hands out connections onto separate empty databases. adk-python pins the
 * same case with SQLAlchemy's `StaticPool`.
 */
function sqlitePoolOptions(dbName: string): Partial<MikroORMOptions> {
  return {
    ...(dbName === ':memory:' ? {pool: {min: 1, max: 1}} : {}),
    driverOptions: {pool: {afterCreate: enableSqliteForeignKeys}},
  };
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
 * @param overrides Options applied on top of the ones the URI implies, the
 *   equivalent of adk-python's engine keyword arguments.
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
  overrides?: Partial<MikroORMOptions>,
): Promise<MikroORMOptions> {
  const {backend} = schemeOf(uri);
  const peer = DRIVER_PEERS[backend];
  if (!peer) {
    throw new Error(`Unsupported database URI: ${redactUriPassword(uri)}`);
  }

  const driver = await loadDriver(uri, backend, peer);

  if (backend === SQLITE_BACKEND) {
    const dbName = uri.slice(
      uri.indexOf(SCHEME_SEPARATOR) + SCHEME_SEPARATOR.length,
    );
    return {
      entities: ENTITIES,
      dbName,
      driver,
      ...sqlitePoolOptions(dbName),
      forceUtcTimezone: true,
      ...overrides,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
    driverOptions: {pool: {validate: connectionIsAlive}},
    forceUtcTimezone: true,
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
