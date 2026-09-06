/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copies an ADK sessions database from the v0 pickle schema into the v1 JSON
 * schema.
 *
 * The v0 schema stored each event's `actions` as a Python pickle and spread
 * the rest of the event across typed columns. The v1 schema stores one
 * `event_data` JSON column and stamps `schema_version = "1"` in
 * `adk_internal_metadata`. This module reads the source and writes a second
 * database; it never writes to the source.
 *
 * Mirrors `google/adk-python`
 * `src/google/adk/sessions/migration/migrate_from_sqlalchemy_pickle.py`.
 */

import {EntityManager, MikroORM} from '@mikro-orm/core';
import {
  createEvent,
  Event,
  transformToCamelCaseEvent,
} from '../../events/event.js';
import {logger} from '../../utils/logger.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  validateDatabaseSchemaVersion,
} from '../db/operations.js';
import {
  StorageAppState,
  StorageEvent,
  StorageSession,
  StorageUserState,
} from '../db/schema.js';
import {
  isPythonObject,
  JsonValue,
  loadsRestricted,
  pythonObjectToJson,
} from './restricted_pickle.js';

/** Options for {@link migrateFromSqlalchemyPickle}. */
export interface MigrateOptions {
  /** SQLAlchemy-style or adk-js-style URL of the v0 source database. */
  sourceDbUrl: string;
  /** URL of the v1 destination database. Created if absent. */
  destDbUrl: string;
  /**
   * Allow a pickled `actions` blob to name a class outside the allowlist. Only
   * use this with a source database you trust.
   */
  allowUnsafeUnpickling?: boolean;
}

/** What {@link migrateFromSqlalchemyPickle} copied. */
export interface MigrationSummary {
  appStates: number;
  userStates: number;
  sessions: number;
  events: number;
  /** Event rows that could not be converted and were left behind. */
  skippedEvents: number;
}

/** One row read from the source database with raw SQL. */
export type SourceRow = Record<string, unknown>;

/** The tables this migration reads, in the order it copies them. */
const APP_STATES = 'app_states';
const USER_STATES = 'user_states';
const SESSIONS = 'sessions';
const EVENTS = 'events';

/** `getConnectionOptionsFromUri` recognises exactly this in-memory form. */
const SQLITE_MEMORY_URI = 'sqlite://:memory:';
const SQLALCHEMY_SQLITE_MEMORY_URI = 'sqlite:///:memory:';

/** Matches the `+driver` suffix SQLAlchemy puts on a URL scheme. */
const DRIVER_SUFFIX_PATTERN = /^([^+:]+)\+[^:]+:\/\//;

/** The two naive datetime forms a v0 `timestamp` column comes back as. */
const NAIVE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

const MICROSECOND_DIGITS = 6;

/**
 * Rewrites a SQLAlchemy connection URL into the form adk-js understands.
 *
 * Mirrors adk-python's `to_sync_url`: a `+driver` suffix names the Python
 * driver and has no counterpart here, so it is dropped. A string that is not a
 * URL is returned unchanged, as the reference does.
 */
export function normalizeLegacyDatabaseUri(uri: string): string {
  const withoutDriver = uri.replace(DRIVER_SUFFIX_PATTERN, '$1://');
  return withoutDriver === SQLALCHEMY_SQLITE_MEMORY_URI
    ? SQLITE_MEMORY_URI
    : withoutDriver;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Reads a v0 `timestamp` column as epoch milliseconds.
 *
 * v0 wrote the column as a naive datetime in local time and read it back the
 * same way, so a naive string is parsed as local time here too. Forcing UTC
 * would shift every migrated event by the host's offset.
 *
 * @returns The epoch milliseconds, or `undefined` when the value is not a
 *   timestamp at all.
 */
export function toEpochMillis(value: unknown): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = NAIVE_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  const microseconds = Number((fraction ?? '').padEnd(MICROSECOND_DIGITS, '0'));
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(microseconds / 1000),
  ).getTime();
}

function toDateOrNow(value: unknown): Date {
  const millis = toEpochMillis(value);
  return millis === undefined ? new Date() : new Date(millis);
}

/**
 * Narrows whichever binary representation the driver produced for a `BLOB`
 * column. Node's `Buffer`, a plain `Uint8Array` and a raw `ArrayBuffer` all
 * reach this code depending on the driver, so all three are matched.
 */
function toBinary(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return undefined;
}

/**
 * Reads a `state` column, which holds a JSON object on every backend and an
 * already-decoded object on Postgres. Port of adk-python's `_get_state_dict`,
 * and exported for direct testing alongside {@link rowToEvent}.
 */
export function toStateRecord(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
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
  if (isPlainRecord(parsed)) {
    return parsed;
  }
  logger.warn('State JSON was not an object, defaulting to empty dict.');
  return {};
}

/**
 * Reads one of the event's JSON columns. Only an object survives: the column
 * holds a serialised model, and a scalar or array in it is corrupt data.
 */
function jsonObjectOf(
  value: unknown,
  eventId: string,
): Record<string, unknown> | undefined {
  if (isPlainRecord(value)) {
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
  if (isPlainRecord(parsed)) {
    return parsed;
  }
  logger.warn(
    `Expected JSON object for event ${eventId}, got ${jsonTypeName(parsed)}.`,
  );
  return undefined;
}

/**
 * Reads the `long_running_tool_ids_json` column.
 *
 * adk-python models this as a set; adk-js models it as an array, so the ids
 * are deduplicated here to keep the two equivalent.
 */
function longRunningToolIdsOf(value: unknown, eventId: string): string[] {
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
  if (!Array.isArray(parsed)) {
    return [];
  }
  const ids: unknown[] = parsed;
  return [...new Set(ids.map((id) => String(id)))];
}

/** Decodes a pickled `actions` blob into the record the v1 column holds. */
function decodedActionsOf(
  bytes: Uint8Array,
  eventId: string,
  allowUnsafeUnpickling: boolean,
): {[key: string]: JsonValue} | undefined {
  try {
    const decoded = loadsRestricted(bytes, {
      allowUnknownGlobals: allowUnsafeUnpickling,
    });
    return isPythonObject(decoded) && decoded.pyClass.endsWith('EventActions')
      ? pythonObjectToJson(decoded)
      : undefined;
  } catch (error) {
    logger.warn(
      `Failed to unpickle actions for event ${eventId}: ${messageOf(error)}`,
    );
    return undefined;
  }
}

/**
 * Reads the `actions` column, which holds a pickle on every SQL backend
 * adk-python supported and an already-decoded object on Spanner.
 */
function actionsOf(
  value: unknown,
  eventId: string,
  allowUnsafeUnpickling: boolean,
): Record<string, unknown> | undefined {
  const bytes = toBinary(value);
  if (bytes) {
    return decodedActionsOf(bytes, eventId, allowUnsafeUnpickling);
  }
  return isPlainRecord(value) ? value : undefined;
}

/** Drops the keys a v1 `event_data` payload leaves out, as v0's `exclude_none` did. */
function definedFieldsOf(record: Record<string, unknown>): SourceRow {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value != null),
  );
}

/** Options for {@link rowToEvent}. */
export interface RowToEventOptions {
  /** See {@link MigrateOptions.allowUnsafeUnpickling}. */
  allowUnsafeUnpickling?: boolean;
}

/**
 * Converts a v0 `events` row into the {@link Event} the v1 `event_data` column
 * holds. Port of adk-python's `_row_to_event`.
 *
 * @throws {Error} If the row has no id or no usable timestamp.
 */
export function rowToEvent(
  row: SourceRow,
  options: RowToEventOptions = {},
): Event {
  const id = row['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error('Event must have an id.');
  }
  const timestamp = toEpochMillis(row['timestamp']);
  if (timestamp === undefined) {
    throw new Error(`Event ${id} must have a timestamp.`);
  }
  // The v0 columns are snake_case, as are the decoded pickle's attributes, so
  // the whole row converts in one pass through the transform the v1 column
  // already uses in both directions.
  const snakeCaseEvent = definedFieldsOf({
    id,
    invocation_id: row['invocation_id'] ?? '',
    author: row['author'] ?? 'agent',
    branch: row['branch'],
    actions: actionsOf(
      row['actions'],
      id,
      options.allowUnsafeUnpickling ?? false,
    ),
    timestamp,
    partial: row['partial'],
    turn_complete: row['turn_complete'],
    error_code: row['error_code'],
    error_message: row['error_message'],
    interrupted: row['interrupted'],
    custom_metadata: jsonObjectOf(row['custom_metadata'], id),
    content: jsonObjectOf(row['content'], id),
    grounding_metadata: jsonObjectOf(row['grounding_metadata'], id),
    usage_metadata: jsonObjectOf(row['usage_metadata'], id),
    citation_metadata: jsonObjectOf(row['citation_metadata'], id),
    input_transcription: jsonObjectOf(row['input_transcription'], id),
    output_transcription: jsonObjectOf(row['output_transcription'], id),
  });
  return createEvent({
    ...transformToCamelCaseEvent(snakeCaseEvent),
    longRunningToolIds: longRunningToolIdsOf(
      row['long_running_tool_ids_json'],
      id,
    ),
  });
}

/** Reads a source table, or reports it absent. */
async function readSourceRows(
  source: MikroORM,
  table: string,
): Promise<SourceRow[] | undefined> {
  const connection = source.em.getConnection();
  try {
    // `table` is one of the module constants above, never caller input.
    await connection.execute(`SELECT 1 FROM ${table} WHERE 1 = 0`, [], 'all');
  } catch {
    return undefined;
  }
  return connection.execute<SourceRow[]>(`SELECT * FROM ${table}`, [], 'all');
}

/**
 * Copies one source table, logging the reference's progress lines.
 *
 * @param copyRow Stages one row for the destination and reports whether it
 *   could be converted.
 * @returns How many rows were staged.
 */
async function copyTable(
  source: MikroORM,
  table: string,
  absentMessage: string,
  copyRow: (row: SourceRow) => Promise<boolean>,
): Promise<number> {
  logger.info(`Migrating ${table}...`);
  const rows = await readSourceRows(source, table);
  if (!rows) {
    logger.info(absentMessage);
    return 0;
  }
  let copied = 0;
  for (const row of rows) {
    if (await copyRow(row)) {
      copied++;
    }
  }
  logger.info(`Migrated ${copied} ${table}.`);
  return copied;
}

/** Copies every source table into the destination inside one transaction. */
async function copyDatabase(
  source: MikroORM,
  em: EntityManager,
  allowUnsafeUnpickling: boolean,
): Promise<MigrationSummary> {
  const appStates = await copyTable(
    source,
    APP_STATES,
    `No '${APP_STATES}' table found in source db.`,
    async (row) => {
      await em.upsert(StorageAppState, {
        appName: String(row['app_name']),
        state: toStateRecord(row['state']),
        updateTime: toDateOrNow(row['update_time']),
      });
      return true;
    },
  );

  const userStates = await copyTable(
    source,
    USER_STATES,
    `No '${USER_STATES}' table found in source db.`,
    async (row) => {
      await em.upsert(StorageUserState, {
        appName: String(row['app_name']),
        userId: String(row['user_id']),
        state: toStateRecord(row['state']),
        updateTime: toDateOrNow(row['update_time']),
      });
      return true;
    },
  );

  const sessions = await copyTable(
    source,
    SESSIONS,
    `No '${SESSIONS}' table found in source db.`,
    async (row) => {
      await em.upsert(StorageSession, {
        id: String(row['id']),
        appName: String(row['app_name']),
        userId: String(row['user_id']),
        state: toStateRecord(row['state']),
        createTime: toDateOrNow(row['create_time']),
        updateTime: toDateOrNow(row['update_time']),
      });
      return true;
    },
  );

  let skippedEvents = 0;
  const events = await copyTable(
    source,
    EVENTS,
    `No '${EVENTS}' table found in source database.`,
    async (row) => {
      try {
        const event = rowToEvent(row, {allowUnsafeUnpickling});
        await em.upsert(StorageEvent, {
          id: event.id,
          appName: String(row['app_name']),
          userId: String(row['user_id']),
          sessionId: String(row['session_id']),
          invocationId: event.invocationId,
          timestamp: new Date(event.timestamp),
          eventData: event,
        });
        return true;
      } catch (error) {
        skippedEvents++;
        logger.warn(
          `Failed to migrate event row ${row['id'] ?? 'N/A'}: ${messageOf(error)}`,
        );
        return false;
      }
    },
  );

  return {appStates, userStates, sessions, events, skippedEvents};
}

/** Opens an ORM against `uri`, reporting a failure with the redacted URL. */
async function connect(uri: string, role: string): Promise<MikroORM> {
  try {
    return await MikroORM.init(
      await getConnectionOptionsFromUri(normalizeLegacyDatabaseUri(uri)),
    );
  } catch (error) {
    const message = `Failed to connect to ${role} database: ${messageOf(error)}`;
    logger.error(message);
    throw new Error(message);
  }
}

/**
 * Copies a v0 pickle-schema sessions database into a v1 JSON-schema database.
 *
 * The source is only read. The destination is created if absent, stamped with
 * `schema_version = "1"`, and written inside one transaction, so a failure
 * part-way leaves no partial copy behind.
 *
 * @param options Source, destination and unpickling options.
 * @returns How many rows of each kind were copied.
 * @throws {Error} If either database cannot be opened, or the copy fails.
 */
export async function migrateFromSqlalchemyPickle(
  options: MigrateOptions,
): Promise<MigrationSummary> {
  const allowUnsafeUnpickling = options.allowUnsafeUnpickling ?? false;

  logger.info(
    `Connecting to source database: ${redactUriPassword(options.sourceDbUrl)}`,
  );
  if (allowUnsafeUnpickling) {
    logger.warn(
      'Unsafe pickle migration mode is enabled. Only use this with a trusted' +
        ' source database.',
    );
  }
  const source = await connect(options.sourceDbUrl, 'source');

  let destination: MikroORM;
  try {
    logger.info(
      `Connecting to destination database: ${redactUriPassword(options.destDbUrl)}`,
    );
    destination = await connect(options.destDbUrl, 'destination');
  } catch (error) {
    await source.close(true);
    throw error;
  }

  try {
    await ensureDatabaseCreated(destination);
    await validateDatabaseSchemaVersion(destination);
    logger.info('Created metadata table in destination database.');
    const summary = await destination.em
      .fork()
      .transactional((em) => copyDatabase(source, em, allowUnsafeUnpickling));
    logger.info('Migration completed successfully.');
    return summary;
  } catch (error) {
    const message = `An error occurred during migration: ${messageOf(error)}`;
    logger.error(message);
    throw new Error(message);
  } finally {
    await source.close(true);
    await destination.close(true);
  }
}

const SOURCE_FLAG = '--source_db_url';
const DEST_FLAG = '--dest_db_url';
const UNSAFE_FLAGS = ['--allow_unsafe_unpickling', '--allow-unsafe-unpickling'];

/**
 * Parses the command-line form of {@link MigrateOptions}.
 *
 * Accepts `--flag value` and `--flag=value`, as argparse does.
 *
 * @throws {Error} If an argument is unknown or a required flag is missing.
 */
export function parseMigrationArgs(argv: string[]): MigrateOptions {
  const values = new Map<string, string>();
  let allowUnsafeUnpickling = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (UNSAFE_FLAGS.includes(name)) {
      allowUnsafeUnpickling = true;
      continue;
    }
    if (name !== SOURCE_FLAG && name !== DEST_FLAG) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value =
      separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined) {
      throw new Error(`${name} needs a value.`);
    }
    values.set(name, value);
  }

  const sourceDbUrl = values.get(SOURCE_FLAG);
  const destDbUrl = values.get(DEST_FLAG);
  if (sourceDbUrl === undefined || destDbUrl === undefined) {
    throw new Error(`Both ${SOURCE_FLAG} and ${DEST_FLAG} are required.`);
  }
  return {sourceDbUrl, destDbUrl, allowUnsafeUnpickling};
}

/**
 * Runs the command-line form of the migration.
 *
 * @param argv The arguments after the script name.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    const summary = await migrateFromSqlalchemyPickle(parseMigrationArgs(argv));
    logger.info(
      `Migrated ${summary.sessions} sessions and ${summary.events} events,` +
        ` skipping ${summary.skippedEvents}.`,
    );
    return 0;
  } catch (error) {
    logger.error(`Migration failed: ${messageOf(error)}`);
    return 1;
  }
}
