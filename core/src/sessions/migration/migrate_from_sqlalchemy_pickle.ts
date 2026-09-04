/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migrates a v0 (pickle) sessions database into a v1 (JSON) one.
 *
 * A sessions database written by an older adk-python stores each event's
 * `actions` as a Python pickle blob and spreads the rest of the event over
 * its own columns. `DatabaseSessionService` refuses to write to that layout.
 * {@link migrate} copies such a database into a new one adk-js can open.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/sessions/migration/migrate_from_sqlalchemy_pickle.py`. The
 * source rows are read with raw `SELECT`s, as the reference reads them, so
 * neither project has to keep a second copy of the obsolete schema.
 */

import {EntityData, EntityManager, EntityName, MikroORM} from '@mikro-orm/core';

import {
  createEvent,
  Event,
  transformToCamelCaseEvent,
} from '../../events/event.js';
import {createEventActions, EventActions} from '../../events/event_actions.js';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
} from '../db/operations.js';
import {
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageAppState,
  StorageEvent,
  StorageMetadata,
  StorageSession,
  StorageUserState,
} from '../db/schema.js';
import {
  loadEventActions,
  RestrictedPickleOptions,
} from '../restricted_pickle.js';

/** Which v0 database to read, and which v1 database to write. */
export interface MigrateOptions {
  /** Connection URL of the v0 (pickle) source database. */
  sourceDbUrl: string;

  /** Connection URL of the v1 (JSON) destination database. */
  destDbUrl: string;

  /**
   * Decode an `events.actions` blob whose types are outside the allowlist.
   * Only use this with a source database you trust.
   */
  allowUnsafeUnpickling?: boolean;
}

/** The v0 tables this migration reads, in the order it reads them. */
const APP_STATES_TABLE = 'app_states';
const USER_STATES_TABLE = 'user_states';
const SESSIONS_TABLE = 'sessions';
const EVENTS_TABLE = 'events';

/** Event columns the v0 schema stores as JSON text or as a JSONB value. */
const CONTENT_COLUMN = 'content';
const GROUNDING_METADATA_COLUMN = 'grounding_metadata';
const CUSTOM_METADATA_COLUMN = 'custom_metadata';
const USAGE_METADATA_COLUMN = 'usage_metadata';
const CITATION_METADATA_COLUMN = 'citation_metadata';
const INPUT_TRANSCRIPTION_COLUMN = 'input_transcription';
const OUTPUT_TRANSCRIPTION_COLUMN = 'output_transcription';

/** Author recorded for a v0 event row that has none, matching the reference. */
const DEFAULT_AUTHOR = 'agent';

/**
 * How each dialect adk-js connects to reports that a table does not exist.
 *
 * Only these mean "not there". Every other read failure - a locked database,
 * a permission error, a corrupt page - is re-thrown, because reporting one of
 * those as an empty table would migrate nothing and still claim success. A
 * server that reports in another language falls on the safe side of that
 * split: the migration aborts rather than skipping the table silently.
 */
const MISSING_TABLE_PATTERNS: readonly RegExp[] = [
  /no such table/i, // SQLite
  /relation "[^"]*" does not exist/i, // PostgreSQL
  /doesn't exist/i, // MySQL and MariaDB
  /invalid object name/i, // SQL Server
];

/** The two shapes SQLAlchemy's SQLite dialect writes a naive datetime in. */
const SQL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

const MILLISECOND_DIGITS = 3;

/** Narrows a value to a JSON object, which excludes an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names a decoded JSON value's kind for a log line. */
function jsonKind(value: unknown): string {
  return Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : typeof value;
}

/**
 * Strips the `+driver` segment from a SQLAlchemy URL.
 *
 * adk-python requires an async driver at runtime, so the URL a user has to
 * hand is usually spelled `postgresql+asyncpg://…`. Migration connects with
 * adk-js's own drivers, which are named by the dialect alone.
 *
 * @param dbUrl A connection URL, with or without a driver segment.
 * @return The URL with the driver segment removed.
 */
export function toSyncUrl(dbUrl: string): string {
  const separator = dbUrl.indexOf('://');
  if (separator === -1) {
    return dbUrl;
  }
  const scheme = dbUrl.slice(0, separator);
  const plus = scheme.indexOf('+');
  return plus === -1
    ? dbUrl
    : `${scheme.slice(0, plus)}${dbUrl.slice(separator)}`;
}

/**
 * Reads a v0 timestamp column.
 *
 * A string is parsed from its components in the host's local zone, because
 * that is the zone adk-python's v0 schema wrote it in: it stored the column
 * with `datetime.fromtimestamp()` and read it back with a naive
 * `.timestamp()`, both of which are local. Reading it as UTC shifts every
 * migrated timestamp by the host's offset.
 *
 * @param value The raw column value.
 * @return The timestamp, or `undefined` when the value is not one.
 */
export function toDateObject(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const parts = SQL_TIMESTAMP.exec(value);
  if (parts === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction] = parts;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    // A v0 fraction is microseconds; a JavaScript Date holds milliseconds.
    Number(
      (fraction ?? '')
        .padEnd(MILLISECOND_DIGITS, '0')
        .slice(0, MILLISECOND_DIGITS),
    ),
  );
}

/** Reads a state column, which holds either a JSON object or its text form. */
export function getStateObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.warn('Failed to parse state JSON string, defaulting to empty dict.');
    return {};
  }
  if (isRecord(parsed)) {
    return parsed;
  }
  logger.warn('State JSON was not an object, defaulting to empty dict.');
  return {};
}

/** Reads one of an event's JSON columns, which must hold an object. */
function safeJsonObject(
  value: unknown,
  eventId: string,
): Record<string, unknown> | undefined {
  // PostgreSQL's JSONB columns arrive already decoded.
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.warn(`Failed to decode JSON for event ${eventId}`);
    return undefined;
  }
  if (isRecord(parsed)) {
    return parsed;
  }
  logger.warn(
    `Expected JSON object for event ${eventId}, got ${jsonKind(parsed)}.`,
  );
  return undefined;
}

/** Reads the JSON array of long-running tool call ids an event may carry. */
function longRunningToolIds(value: unknown, eventId: string): string[] {
  if (typeof value !== 'string' || value === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.warn(
      `Failed to decode long_running_tool_ids_json for event ${eventId}`,
    );
    return [];
  }
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/** Reads a column that must hold text. */
function requireString(
  row: Record<string, unknown>,
  column: string,
  table: string,
): string {
  const value = row[column];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Row in '${table}' has no ${column}.`);
  }
  return value;
}

/** Reads a column that must hold a timestamp. */
function requireDate(
  row: Record<string, unknown>,
  column: string,
  table: string,
): Date {
  const value = toDateObject(row[column]);
  if (value === undefined) {
    throw new Error(`Row in '${table}' has no readable ${column}.`);
  }
  return value;
}

/** Reads an event's `actions` column, whatever binary form the driver used. */
function rowActions(
  value: unknown,
  eventId: string,
  options: RestrictedPickleOptions,
): EventActions {
  if (value === undefined || value === null) {
    return createEventActions();
  }
  try {
    if (ArrayBuffer.isView(value)) {
      return loadEventActions(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        options,
      );
    }
    if (value instanceof ArrayBuffer) {
      return loadEventActions(new Uint8Array(value), options);
    }
    if (isRecord(value)) {
      // Some drivers, Spanner among them, return the column already decoded.
      const {actions} = transformToCamelCaseEvent({actions: value});
      return createEventActions(actions);
    }
  } catch (err: unknown) {
    logger.warn(
      `Failed to unpickle actions for event ${eventId}: ${formatError(err)}`,
    );
  }
  return createEventActions();
}

/**
 * Builds an adk-js {@link Event} from one v0 `events` row.
 *
 * A row whose `actions` blob cannot be decoded still migrates, with empty
 * actions: losing the deltas of one event is better than losing the event.
 *
 * @param row The raw row, keyed by v0 column name.
 * @param options Whether to accept an actions blob outside the allowlist.
 * @return The event to store in the destination's `event_data` column.
 * @throws If the row has no id or no readable timestamp.
 */
export function rowToEvent(
  row: Record<string, unknown>,
  options: RestrictedPickleOptions = {},
): Event {
  const id = row['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error('Event must have an id.');
  }
  const timestamp = toDateObject(row['timestamp']);
  if (timestamp === undefined) {
    throw new Error(`Event ${id} must have a timestamp.`);
  }
  const author = row['author'];
  const branch = row['branch'];
  const invocationId = row['invocation_id'];

  return createEvent({
    id,
    invocationId: typeof invocationId === 'string' ? invocationId : '',
    author: typeof author === 'string' ? author : DEFAULT_AUTHOR,
    branch: typeof branch === 'string' ? branch : undefined,
    actions: rowActions(row['actions'], id, options),
    timestamp: timestamp.getTime(),
    longRunningToolIds: longRunningToolIds(
      row['long_running_tool_ids_json'],
      id,
    ),
    partial: readBoolean(row['partial']),
    turnComplete: readBoolean(row['turn_complete']),
    errorCode: readText(row['error_code']),
    errorMessage: readText(row['error_message']),
    interrupted: readBoolean(row['interrupted']),
    customMetadata: safeJsonObject(row[CUSTOM_METADATA_COLUMN], id),
    content: safeJsonObject(row[CONTENT_COLUMN], id),
    groundingMetadata: safeJsonObject(row[GROUNDING_METADATA_COLUMN], id),
    usageMetadata: safeJsonObject(row[USAGE_METADATA_COLUMN], id),
    citationMetadata: safeJsonObject(row[CITATION_METADATA_COLUMN], id),
    inputTranscription: safeJsonObject(row[INPUT_TRANSCRIPTION_COLUMN], id),
    outputTranscription: safeJsonObject(row[OUTPUT_TRANSCRIPTION_COLUMN], id),
  });
}

/** Reads a column that holds a boolean, which SQLite stores as 0 or 1. */
function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return typeof value === 'number' ? value !== 0 : undefined;
}

/** Reads an optional text column. */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads every row of one source table.
 *
 * A v0 database written before app and user state existed has no `app_states`
 * or `user_states` table, so an absent table is skipped rather than being an
 * error. Only the dialect's own "no such table" report counts as absent; see
 * {@link MISSING_TABLE_PATTERNS} for why everything else has to abort.
 *
 * @return The rows, or `undefined` when the table is not there.
 * @throws The read error, when the table exists but cannot be read.
 */
async function readTable(
  source: MikroORM,
  table: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  try {
    // The table name is one of this module's constants, never caller input.
    const rows: unknown = await source.em
      .getConnection()
      .execute(`SELECT * FROM ${table}`);
    return Array.isArray(rows) ? rows.filter(isRecord) : [];
  } catch (err: unknown) {
    if (!isMissingTable(err)) {
      throw err;
    }
    return undefined;
  }
}

/** Returns whether a failed read means the table is not there. */
function isMissingTable(err: unknown): boolean {
  const message = formatError(err);
  return MISSING_TABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Copies one source table into the destination.
 *
 * @param toEntityData Maps a source row to a destination row, or returns
 *   `undefined` to skip the row after reporting why itself.
 * @param onConflictFields The columns the upsert matches an existing row on.
 *   Pass it when the entity declares a primary relation, because MikroORM
 *   cannot infer the fields from such a key.
 */
async function migrateTable<T extends object>(
  source: MikroORM,
  em: EntityManager,
  table: string,
  entity: EntityName<T>,
  toEntityData: (row: Record<string, unknown>) => EntityData<T> | undefined,
  onConflictFields?: Array<keyof T>,
): Promise<void> {
  logger.info(`Migrating ${table}...`);
  const rows = await readTable(source, table);
  if (rows === undefined) {
    logger.info(`No '${table}' table found in source db.`);
    return;
  }
  const migrated = rows
    .map(toEntityData)
    .filter((data): data is EntityData<T> => data !== undefined);
  if (migrated.length > 0) {
    await em.upsertMany(entity, migrated, {onConflictFields});
  }
  logger.info(`Migrated ${migrated.length} ${table}.`);
}

/** Copies every table, inside the destination's single transaction. */
async function copyTables(
  source: MikroORM,
  em: EntityManager,
  options: MigrateOptions,
): Promise<void> {
  await em.upsert(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
    value: SCHEMA_VERSION_1_JSON,
  });
  logger.info('Created metadata table in destination database.');

  await migrateTable(source, em, APP_STATES_TABLE, StorageAppState, (row) => ({
    appName: requireString(row, 'app_name', APP_STATES_TABLE),
    state: getStateObject(row['state']),
    updateTime: requireDate(row, 'update_time', APP_STATES_TABLE),
  }));

  await migrateTable(
    source,
    em,
    USER_STATES_TABLE,
    StorageUserState,
    (row) => ({
      appName: requireString(row, 'app_name', USER_STATES_TABLE),
      userId: requireString(row, 'user_id', USER_STATES_TABLE),
      state: getStateObject(row['state']),
      updateTime: requireDate(row, 'update_time', USER_STATES_TABLE),
    }),
  );

  await migrateTable(source, em, SESSIONS_TABLE, StorageSession, (row) => ({
    id: requireString(row, 'id', SESSIONS_TABLE),
    appName: requireString(row, 'app_name', SESSIONS_TABLE),
    userId: requireString(row, 'user_id', SESSIONS_TABLE),
    state: getStateObject(row['state']),
    createTime: requireDate(row, 'create_time', SESSIONS_TABLE),
    updateTime: requireDate(row, 'update_time', SESSIONS_TABLE),
  }));

  // `StorageEvent` also declares its owning session as a primary relation, and
  // that relation maps onto three of the four key columns below. MikroORM
  // serializes it into a nested filter, so the upsert must name the columns.
  await migrateTable(
    source,
    em,
    EVENTS_TABLE,
    StorageEvent,
    (row) => toStorageEvent(row, options),
    ['id', 'appName', 'userId', 'sessionId'],
  );
}

/** Maps one v0 `events` row, reporting and skipping a row it cannot read. */
function toStorageEvent(
  row: Record<string, unknown>,
  options: MigrateOptions,
): EntityData<StorageEvent> | undefined {
  try {
    const event = rowToEvent(row, {
      allowUnsafeUnpickling: options.allowUnsafeUnpickling,
    });
    return {
      id: event.id,
      appName: requireString(row, 'app_name', EVENTS_TABLE),
      userId: requireString(row, 'user_id', EVENTS_TABLE),
      sessionId: requireString(row, 'session_id', EVENTS_TABLE),
      invocationId: event.invocationId,
      timestamp: new Date(event.timestamp),
      eventData: event,
    };
  } catch (err: unknown) {
    logger.warn(
      `Failed to migrate event row ${row['id'] ?? 'N/A'}: ${formatError(err)}`,
    );
    return undefined;
  }
}

/** Opens one side of the migration, reporting a failure without its secrets. */
async function openDatabase(
  dbUrl: string,
  role: 'source' | 'destination',
  createSchema: boolean,
): Promise<MikroORM> {
  let orm: MikroORM | undefined;
  try {
    orm = await MikroORM.init(
      await getConnectionOptionsFromUri(toSyncUrl(dbUrl)),
    );
    if (createSchema) {
      await ensureDatabaseCreated(orm);
    }
    return orm;
  } catch (err: unknown) {
    await orm?.close(true);
    const message =
      `Failed to connect to ${role} database ` +
      `${redactUriPassword(dbUrl)}: ${formatError(err)}`;
    logger.error(message);
    throw new Error(message, {cause: err});
  }
}

/**
 * Copies a v0 (pickle) sessions database into a v1 (JSON) one.
 *
 * The destination is created if it does not exist, is stamped with schema
 * version 1, and is committed once at the end: a failure part-way leaves it
 * untouched. The source is only ever read from.
 *
 * ```ts
 * await migrate({
 *   sourceDbUrl: 'sqlite://./legacy_sessions.db',
 *   destDbUrl: 'sqlite://./sessions.db',
 * });
 * ```
 *
 * @param options The two databases, and whether to relax the pickle allowlist.
 * @throws If either database cannot be opened, or the copy fails.
 */
export async function migrate(options: MigrateOptions): Promise<void> {
  logger.info(
    `Connecting to source database: ${redactUriPassword(options.sourceDbUrl)}`,
  );
  if (options.allowUnsafeUnpickling === true) {
    logger.warn(
      'Unsafe pickle migration mode is enabled. Only use this with a ' +
        'trusted source database.',
    );
  }

  const source = await openDatabase(options.sourceDbUrl, 'source', false);
  try {
    logger.info(
      `Connecting to destination database: ${redactUriPassword(options.destDbUrl)}`,
    );
    const destination = await openDatabase(
      options.destDbUrl,
      'destination',
      true,
    );
    try {
      await destination.em.transactional((em) =>
        copyTables(source, em, options),
      );
      logger.info('Migration completed successfully.');
    } catch (err: unknown) {
      const message = `An error occurred during migration: ${formatError(err)}`;
      logger.error(message);
      throw new Error(message, {cause: err});
    } finally {
      await destination.close(true);
    }
  } finally {
    await source.close(true);
  }
}
