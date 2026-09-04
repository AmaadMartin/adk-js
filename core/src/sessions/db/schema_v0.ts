/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  EntityProperty,
  Index,
  ManyToOne,
  Platform,
  PrimaryKey,
  Property,
  Ref,
  RequiredEntityData,
  Type,
} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {logger} from '../../utils/logger.js';
import {
  decodeEventActionsPickle,
  encodeEventActionsPickle,
} from './event_actions_pickle.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  EVENTS_TABLE_NAME,
  EVENTS_TIMESTAMP_INDEX_NAME,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageAppState,
  StorageSession,
  StorageUserState,
} from './schema.js';

/** The marker a truncated value ends with, as adk-python writes it. */
export const TRUNCATION_SUFFIX = '...[truncated]';

/**
 * The default character set of the platforms whose `blob` holds only 64 KiB.
 *
 * MikroORM's `Platform` exposes no dialect name, and neither `instanceof` nor
 * `constructor.name` can stand in for one: two copies of a driver package in
 * one runtime defeat the first, and a bundler defeats the second. MySQL and
 * MariaDB are exactly the platforms MikroORM defaults to `utf8mb4`, so their
 * charset is the identity this type dispatches on. A schema test pins the
 * mapping across every supported platform, so a change in MikroORM fails the
 * build rather than silently restoring the 64 KiB column.
 */
const MYSQL_FAMILY_DEFAULT_CHARSET = 'utf8mb4';

/** The MySQL and MariaDB column that holds a blob of any size. */
const LONG_BLOB_COLUMN_TYPE = 'longblob';

/**
 * Returns the column a platform needs for a pickled value.
 *
 * The counterpart of adk-python's `DynamicPickleType.load_dialect_impl`. A
 * MySQL `BLOB` holds 64 KiB, which a large `stateDelta` overruns, and the
 * insert fails rather than truncating. adk-python also has a Spanner branch;
 * adk-js has no Spanner driver, so there is nothing to dispatch to.
 *
 * @param platform The platform the column is declared for.
 * @returns The column type.
 */
export function pickleBlobColumnType(
  platform: Pick<Platform, 'getDefaultCharset' | 'getBlobDeclarationSQL'>,
): string {
  return platform.getDefaultCharset() === MYSQL_FAMILY_DEFAULT_CHARSET
    ? LONG_BLOB_COLUMN_TYPE
    : platform.getBlobDeclarationSQL();
}

/** The `actions` column, widened to `LONGBLOB` on MySQL and MariaDB. */
export class PickleBlobType extends Type<Uint8Array | null, Buffer | null> {
  override convertToDatabaseValue(value: Uint8Array | null): Buffer | null {
    return value ? Buffer.from(value) : null;
  }

  override convertToJSValue(value: Buffer | null): Uint8Array | null {
    return value ?? null;
  }

  override getColumnType(_prop: EntityProperty, platform: Platform): string {
    return pickleBlobColumnType(platform);
  }

  override compareAsType(): string {
    return 'Buffer';
  }
}

/** Reads the stored JSON of an event's long-running tool call ids. */
function parseLongRunningToolIds(stored: string | undefined): string[] {
  return stored ? (JSON.parse(stored) as string[]) : [];
}

/** Renders an event's long-running tool call ids for storage. */
function serializeLongRunningToolIds(
  value: readonly string[] | undefined,
): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * Truncates a value to fit a column of `maxLength` characters.
 *
 * A database written by an older ADK can still carry a `VARCHAR(N)` column
 * that was never altered after the schema definition moved to text.
 * Truncating before the insert turns a failed write into a shortened value.
 *
 * @param value The value to store, if there is one.
 * @param maxLength The width the column holds.
 * @returns The value, shortened when it does not fit.
 */
export function truncateStr(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  logger.warn(
    `Truncated value from ${value.length} to ${maxLength} characters to fit` +
      ' a database column. Run the matching ALTER TABLE command, or migrate' +
      ' to the v1 schema, to store full-length values.',
  );
  return (
    value.slice(0, maxLength - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
  );
}

/**
 * The `events` table as adk-python wrote it before the v1 schema.
 *
 * It spreads an event across typed columns instead of the single JSON
 * `event_data` column the current {@link StorageEvent} uses, and stores the
 * event's actions as a Python pickle.
 *
 * Mirrors `src/google/adk/sessions/schemas/v0.py` in adk-python.
 *
 * The index below carries the name the current schema's event index also
 * carries. The two entity sets both describe the `events` table and are never
 * registered with one `MikroORM` instance, so there is one index per database,
 * not two.
 */
@Index({
  name: EVENTS_TIMESTAMP_INDEX_NAME,
  expression:
    `create index ${EVENTS_TIMESTAMP_INDEX_NAME} on ${EVENTS_TABLE_NAME} ` +
    `(app_name, user_id, session_id, timestamp desc)`,
})
@Entity({tableName: EVENTS_TABLE_NAME})
export class StorageEventV0 {
  @PrimaryKey({type: 'string', length: STORAGE_KEY_COLUMN_LENGTH})
  id!: string;

  @PrimaryKey({
    type: 'string',
    fieldName: 'app_name',
    length: STORAGE_KEY_COLUMN_LENGTH,
  })
  appName!: string;

  @PrimaryKey({
    type: 'string',
    fieldName: 'user_id',
    length: STORAGE_KEY_COLUMN_LENGTH,
  })
  userId!: string;

  @PrimaryKey({
    type: 'string',
    fieldName: 'session_id',
    length: STORAGE_KEY_COLUMN_LENGTH,
  })
  sessionId!: string;

  @Property({type: 'string', fieldName: 'invocation_id'})
  invocationId!: string;

  @Property({type: 'string'})
  author!: string;

  @Property({type: 'string', nullable: true})
  branch?: string;

  @Property({type: 'datetime'})
  timestamp!: Date;

  @Property({type: 'json', nullable: true})
  content?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'grounding_metadata', nullable: true})
  groundingMetadata?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'custom_metadata', nullable: true})
  customMetadata?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'usage_metadata', nullable: true})
  usageMetadata?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'citation_metadata', nullable: true})
  citationMetadata?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'input_transcription', nullable: true})
  inputTranscription?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'output_transcription', nullable: true})
  outputTranscription?: Record<string, unknown>;

  @Property({type: 'boolean', nullable: true})
  partial?: boolean;

  @Property({type: 'boolean', fieldName: 'turn_complete', nullable: true})
  turnComplete?: boolean;

  @Property({type: 'string', fieldName: 'error_code', nullable: true})
  errorCode?: string;

  @Property({type: 'text', fieldName: 'error_message', nullable: true})
  errorMessage?: string;

  @Property({type: 'boolean', nullable: true})
  interrupted?: boolean;

  @Property({
    type: 'text',
    fieldName: 'long_running_tool_ids_json',
    nullable: true,
  })
  longRunningToolIdsJson?: string;

  /** A Python pickle of the event's actions. */
  @Property({type: PickleBlobType, nullable: true})
  actions?: Uint8Array;

  /**
   * The owning session, mapped onto the `app_name`, `user_id` and `session_id`
   * primary-key columns the scalar properties above already declare.
   *
   * It carries the `events -> sessions ON DELETE CASCADE` constraint
   * adk-python declares, so deleting a session row removes its events even
   * when the caller never goes through this entity.
   *
   * Both column lists follow {@link StorageSession}'s primary-key order, and
   * must keep following it. MikroORM appends the relation to the WHERE clause
   * of every UPDATE and DELETE as a tuple, and builds the right-hand side by
   * serializing the referenced entity's primary key in its declared order, so
   * a list in another order compares the two sides misaligned and the write
   * matches no row. InnoDB then only accepts a foreign key whose referenced
   * columns lead an index of the parent table, and that primary key is the
   * only index `sessions` has; MySQL 8.0 rejects any other order with errno
   * 1822.
   */
  @ManyToOne(() => StorageSession, {
    primary: true,
    fieldNames: ['session_id', 'app_name', 'user_id'],
    referencedColumnNames: ['id', 'app_name', 'user_id'],
    deleteRule: 'cascade',
    updateRule: 'cascade',
    ref: true,
    index: false,
  })
  storageSession!: Ref<StorageSession>;

  /**
   * The ids of the tool calls this event started and did not finish.
   *
   * `persist: false` keeps the accessor out of the table: the pair reads and
   * writes {@link StorageEventV0.longRunningToolIdsJson}, which is the column.
   * MikroORM still assigns it when it builds a row, so the setter is what
   * turns the list into the stored JSON.
   */
  @Property({persist: false})
  get longRunningToolIds(): string[] {
    return parseLongRunningToolIds(this.longRunningToolIdsJson);
  }

  set longRunningToolIds(value: string[] | undefined) {
    this.longRunningToolIdsJson = serializeLongRunningToolIds(value);
  }

  [PrimaryKey.name]?: [string, string, string, string];
}

/**
 * The entity set for a legacy database.
 *
 * `sessions`, `app_states` and `user_states` are identical in both layouts, so
 * only the event entity differs. There is no metadata entity: a legacy
 * database has no `adk_internal_metadata` table.
 */
export const ENTITIES_V0 = [
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEventV0,
];

/** The typed JSON columns, and the snake_case field each one holds. */
const JSON_COLUMNS = [
  ['content', 'content'],
  ['groundingMetadata', 'grounding_metadata'],
  ['customMetadata', 'custom_metadata'],
  ['usageMetadata', 'usage_metadata'],
  ['citationMetadata', 'citation_metadata'],
  ['inputTranscription', 'input_transcription'],
  ['outputTranscription', 'output_transcription'],
] as const;

/**
 * Builds a legacy row for an event.
 *
 * adk-python's `StorageEvent.from_event` takes the `Session`; this takes the
 * loaded {@link StorageSession} instead, because the row is what populates the
 * `storageSession` relation. Leaving that relation unset lets MikroORM's
 * snapshot comparator write a null over the foreign-key columns.
 *
 * The JSON columns hold what adk-python's `model_dump(mode="json")` produced,
 * so they come from the same snake_case transform the read path reverses.
 * A column stays null when the event has nothing for it, as adk-python's
 * `from_event` leaves it.
 *
 * @param storageSession The session row the event belongs to.
 * @param event The event to store.
 * @returns The row data.
 */
export function storageEventV0FromEvent(
  storageSession: StorageSession,
  event: Event,
): RequiredEntityData<StorageEventV0> {
  const stored = transformToSnakeCaseEvent(event);
  const row: RequiredEntityData<StorageEventV0> = {
    id: event.id,
    appName: storageSession.appName,
    userId: storageSession.userId,
    sessionId: storageSession.id,
    storageSession,
    invocationId: event.invocationId,
    // adk-python declares `author` non-null and adk-js declares it optional.
    author: event.author ?? '',
    branch: event.branch,
    // adk-js measures `Event.timestamp` in milliseconds, adk-python in POSIX
    // seconds. The column keeps what adk-js wrote.
    timestamp: new Date(event.timestamp),
    actions: encodeEventActionsPickle(event.actions),
    longRunningToolIds: event.longRunningToolIds,
    partial: event.partial,
    turnComplete: event.turnComplete,
    errorCode: event.errorCode,
    errorMessage: truncateStr(event.errorMessage, DEFAULT_MAX_VARCHAR_LENGTH),
    interrupted: event.interrupted,
  };
  for (const [column, field] of JSON_COLUMNS) {
    const value = stored[field];
    if (value) {
      row[column] = value as Record<string, unknown>;
    }
  }
  return row;
}

/**
 * Converts a legacy row into an {@link Event}.
 *
 * A decode failure is not swallowed into empty actions. Losing a `stateDelta`
 * silently is the defect this codec exists to fix, so the caller decides what
 * an unreadable row means.
 *
 * @param row The row to convert.
 * @returns The event the row holds.
 */
export function storageEventV0ToEvent(row: StorageEventV0): Event {
  const event = transformToCamelCaseEvent({
    id: row.id,
    invocation_id: row.invocationId,
    author: row.author,
    branch: row.branch,
    timestamp: row.timestamp.getTime(),
    content: row.content,
    grounding_metadata: row.groundingMetadata,
    custom_metadata: row.customMetadata,
    usage_metadata: row.usageMetadata,
    citation_metadata: row.citationMetadata,
    input_transcription: row.inputTranscription,
    output_transcription: row.outputTranscription,
    partial: row.partial,
    turn_complete: row.turnComplete,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    interrupted: row.interrupted,
    long_running_tool_ids: row.longRunningToolIdsJson
      ? parseLongRunningToolIds(row.longRunningToolIdsJson)
      : undefined,
  });

  event.actions = row.actions
    ? decodeEventActionsPickle(row.actions)
    : createEventActions();
  return event;
}
