/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
} from './operations.js';
import {ENTITIES, StorageMetadata} from './schema.js';

/** Key of the `adk_internal_metadata` row that holds the schema version. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/** JSON-serialized event payload schema, shared with adk-python's v1. */
export const SCHEMA_VERSION_1_JSON = '1';

/** Version stamped on a database this build creates. */
export const LATEST_SCHEMA_VERSION = SCHEMA_VERSION_1_JSON;

/**
 * Versions this build can read and write.
 *
 * A release keeps the previous version here for its deprecation window rather
 * than removing it, so an existing database keeps opening after a bump. See
 * `core/src/sessions/db/README.md`.
 */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([
  SCHEMA_VERSION_1_JSON,
]);

/**
 * Throws when the database holds a version this build cannot read.
 *
 * An absent version row is a new database, which is compatible by definition.
 *
 * @param version The stored version, or undefined when the row is absent.
 * @throws Error naming the accepted versions and both remedies.
 */
function assertCompatibleVersion(version: string | undefined): void {
  if (version === undefined || SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    return;
  }

  const supported = [...SUPPORTED_SCHEMA_VERSIONS].join(', ');
  throw new Error(
    `ADK Database schema version ${version} is not compatible. ` +
      `This build of ADK supports schema version(s) ${supported}. ` +
      `Upgrade the @google/adk package if the database was written by a ` +
      `newer release, or call upgradeSessionDatabaseSchema() to bring an ` +
      `older database up to version ${LATEST_SCHEMA_VERSION}.`,
  );
}

/**
 * Reads the schema version stored in the database.
 *
 * @param orm The MikroORM instance.
 * @returns The stored version, or undefined when the row is absent.
 */
export async function readSchemaVersion(
  orm: MikroORM,
): Promise<string | undefined> {
  const em = orm.em.fork();
  const existing = await em.findOne(StorageMetadata, {key: SCHEMA_VERSION_KEY});

  return existing?.value;
}

/**
 * Writes the schema version, replacing any value already stored.
 *
 * @param orm The MikroORM instance.
 * @param version The version to store.
 */
export async function stampSchemaVersion(
  orm: MikroORM,
  version: string,
): Promise<void> {
  const em = orm.em.fork();
  const existing = await em.findOne(StorageMetadata, {key: SCHEMA_VERSION_KEY});

  if (existing) {
    existing.value = version;
    return em.flush();
  }

  const created = em.create(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
    value: version,
  });

  return em.persist(created).flush();
}

/**
 * Validates the schema version of an open database, stamping a new one.
 *
 * An existing version row is never rewritten; moving a database to a newer
 * version is `upgradeSessionDatabaseSchema`'s job.
 *
 * @param orm The MikroORM instance.
 * @throws Error if the stored version is outside `SUPPORTED_SCHEMA_VERSIONS`.
 */
export async function validateDatabaseSchemaVersion(
  orm: MikroORM,
): Promise<void> {
  const version = await readSchemaVersion(orm);
  assertCompatibleVersion(version);

  if (version === undefined) {
    await stampSchemaVersion(orm, LATEST_SCHEMA_VERSION);
  }
}

/**
 * Brings a session database up to `LATEST_SCHEMA_VERSION` in place.
 *
 * Applies the additive DDL this build expects, then stamps the version row.
 * Idempotent: a database already at the latest version is left untouched. The
 * connection is closed on every exit path.
 *
 * @param connectionStringOrOptions A database URI, or MikroORM options
 *   carrying a driver.
 * @throws Error if the stored version is outside `SUPPORTED_SCHEMA_VERSIONS`.
 */
export async function upgradeSessionDatabaseSchema(
  connectionStringOrOptions: string | MikroORMOptions,
): Promise<void> {
  const options =
    typeof connectionStringOrOptions === 'string'
      ? await getConnectionOptionsFromUri(connectionStringOrOptions)
      : {...connectionStringOrOptions, entities: ENTITIES};

  if (!options.driver) {
    throw new Error('Driver is required when passing options object.');
  }

  const orm = await MikroORM.init(options);

  try {
    await ensureDatabaseCreated(orm);

    const version = await readSchemaVersion(orm);
    assertCompatibleVersion(version);

    if (version === LATEST_SCHEMA_VERSION) {
      logger.debug(
        `Session database is already at schema version ${LATEST_SCHEMA_VERSION}.`,
      );
      return;
    }

    await stampSchemaVersion(orm, LATEST_SCHEMA_VERSION);
  } finally {
    await orm.close();
  }
}
