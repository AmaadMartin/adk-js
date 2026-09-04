/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-shot migration of an ADK sessions database from the v0 pickle schema to
 * the v1 JSON schema.
 *
 * This entry point is Node-only and needs a database driver, so it is a
 * separate subpath export (`@google/adk/sessions/migration`) rather than part
 * of the root entry point.
 */

export {
  main,
  migrateFromSqlalchemyPickle,
  normalizeLegacyDatabaseUri,
  parseMigrationArgs,
  rowToEvent,
  toEpochMillis,
  type MigrateOptions,
  type MigrationSummary,
  type RowToEventOptions,
  type SourceRow,
} from './migrate_from_sqlalchemy_pickle.js';
export {
  UnpicklingError,
  isPythonObject,
  loadsRestricted,
  pickleToJson,
  pythonObjectToJson,
  type JsonValue,
  type PickleValue,
  type PythonObject,
  type UnpickleOptions,
} from './restricted_pickle.js';
