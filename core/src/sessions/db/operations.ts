/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {naiveDatetimeOptions} from './dialect.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** Backend name this module normalizes the sqlite dialect to. */
const SQLITE_BACKEND = 'sqlite';

/** Dialect name the sqlite driver reports through knex. */
const SQLITE_KNEX_DIALECT = 'sqlite3';

/** A driver connection that exposes the knex instance underneath it. */
interface KnexBackedConnection {
  getKnex(): {client?: {dialect?: unknown}};
}

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

function isKnexBackedConnection(value: object): value is KnexBackedConnection {
  return 'getKnex' in value && typeof value.getKnex === 'function';
}

/**
 * Returns the backend name the open database reports.
 *
 * adk-python reads `engine.dialect.name`, which spells sqlite `sqlite`. knex
 * spells it `sqlite3`, so that one name is normalized.
 *
 * @param orm The initialized MikroORM instance.
 * @returns The backend name, or an empty string when the driver names no
 *   dialect.
 */
export function getDatabaseBackend(orm: MikroORM): string {
  const connection: object = orm.em.getConnection();
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
 * Parses a database connection URI and returns MikroORM Options.
 *
 * A backend that drops the time zone on a datetime column is opened on UTC, so
 * that the stored wall clock does not follow the Node process's local zone.
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

  // The scheme is the backend name, and the chain above has already rejected
  // every scheme this module does not support.
  const timezone = naiveDatetimeOptions(uri.slice(0, uri.indexOf('://')));

  if (uri.startsWith('sqlite://')) {
    return {
      entities: ENTITIES,
      dbName:
        uri === 'sqlite://:memory:'
          ? ':memory:'
          : uri.substring('sqlite://'.length),
      driver,
      ...timezone,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
    ...timezone,
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
