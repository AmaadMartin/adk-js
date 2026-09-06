/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** Prefix that introduces a sqlite connection string. */
const SQLITE_URI_PREFIX = 'sqlite://';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
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
    const {dbName, query} = parseSqliteUri(uri);
    return {
      entities: ENTITIES,
      dbName,
      driver,
      driverOptions: {
        // knex reaches every connection it opens through this hook, while the
        // `pool` option stays free for the caller to replace.
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
