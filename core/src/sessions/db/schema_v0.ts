/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Ref,
} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {logger} from '../../utils/logger.js';
import {dumpEventActions, loadEventActions} from '../restricted_pickle.js';
import {Session} from '../session.js';
import {
  DATETIME_FRACTIONAL_DIGITS,
  DEFAULT_MAX_VARCHAR_LENGTH,
  EVENTS_SESSION_TIMESTAMP_INDEX,
  EVENTS_TABLE_NAME,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageAppState,
  StorageSession,
  StorageUserState,
} from './schema.js';

/** Suffix appended to a value truncated to fit a legacy column. */
const TRUNCATION_SUFFIX = '...[truncated]';

/**
 * The `events` table as adk-python wrote it before the v1 schema.
 *
 * It spreads an event across typed columns instead of the single JSON
 * `event_data` column {@link StorageEvent} uses, and holds `actions` as a
 * Python pickle rather than JSON.
 *
 * Mirrors `src/google/adk/sessions/schemas/v0.py` in adk-python.
 */
@Entity({tableName: EVENTS_TABLE_NAME})
@Index({
  name: EVENTS_SESSION_TIMESTAMP_INDEX,
  properties: ['appName', 'userId', 'sessionId', 'timestamp'],
})
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

  @Property({type: 'datetime', length: DATETIME_FRACTIONAL_DIGITS})
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
  @Property({type: 'blob', nullable: true})
  actions?: Buffer;

  /**
   * The session this event belongs to, read through the key columns above.
   *
   * This relation carries the `ON DELETE CASCADE` foreign key, so a deleted
   * session takes its events with it. `ownColumns: []` leaves `appName`,
   * `userId` and `sessionId` owning their columns, because they are primary
   * keys that callers set by name.
   *
   * The referenced columns are listed in the order of the `sessions` primary
   * key. InnoDB only accepts a foreign key whose referenced columns lead an
   * index of the parent table, and that primary key is the only index
   * `sessions` has.
   */
  @ManyToOne(() => StorageSession, {
    joinColumns: ['session_id', 'app_name', 'user_id'],
    referencedColumnNames: ['id', 'app_name', 'user_id'],
    deleteRule: 'cascade',
    updateRule: 'no action',
    ownColumns: [],
    index: false,
    nullable: true,
    ref: true,
  })
  session?: Ref<StorageSession>;

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

/**
 * Truncates a value to fit a legacy column, and says so once.
 *
 * A database created by an older ADK may still carry a `VARCHAR(N)` column
 * that was never widened, and an over-long value fails the INSERT there.
 *
 * Mirrors `_truncate_str` in adk-python's `schemas/v0.py`.
 *
 * @param value The value bound for the column.
 * @param maxLength The column's width, in characters.
 * @return The value, at most `maxLength` characters long.
 */
export function truncateStr(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  logger.warn(
    `Truncated value from ${value.length} to ${maxLength} characters to fit ` +
      'a database column constraint. Run the appropriate ALTER TABLE command ' +
      'or migrate to the v1 schema to store full-length values.',
  );
  return (
    value.slice(0, maxLength - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
  );
}

/** Reads the long-running tool ids a legacy row carries. */
export function longRunningToolIdsOf(
  row: StorageEventV0,
): string[] | undefined {
  if (!row.longRunningToolIdsJson) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(row.longRunningToolIdsJson);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.filter((id): id is string => typeof id === 'string');
}

/** Writes the long-running tool ids into the row's JSON column. */
export function setLongRunningToolIds(
  row: StorageEventV0,
  value: string[] | undefined,
): void {
  row.longRunningToolIdsJson =
    value === undefined ? undefined : JSON.stringify(value);
}

/** Narrows a transformed event field to a value a JSON column can hold. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one JSON column out of a snake_cased event. */
function jsonColumn(
  event: Record<string, unknown>,
  column: string,
): Record<string, unknown> | undefined {
  const value = event[column];
  return isJsonObject(value) ? value : undefined;
}

/**
 * Builds a legacy row from an {@link Event}.
 *
 * The JSON columns hold the same snake_cased shape adk-python's
 * `model_dump(mode="json")` writes, and `actions` holds the pickle
 * adk-python's restricted unpickler reads, so a row written here is one
 * adk-python 1.19 to 1.21 can load.
 *
 * Mirrors `StorageEvent.from_event` in adk-python's `schemas/v0.py`.
 *
 * @param session The session the event belongs to.
 * @param event The event to store.
 * @return The row, ready to persist.
 * @throws If the event's actions hold a value with no Python counterpart.
 */
export function storageEventV0FromEvent(
  session: Session,
  event: Event,
): StorageEventV0 {
  const snakeCased = transformToSnakeCaseEvent(event);

  const row = new StorageEventV0();
  row.id = event.id;
  row.appName = session.appName;
  row.userId = session.userId;
  row.sessionId = session.id;
  row.invocationId = event.invocationId;
  row.author = event.author ?? '';
  row.branch = event.branch;
  row.timestamp = new Date(event.timestamp);
  row.actions = Buffer.from(dumpEventActions(event.actions));
  row.partial = event.partial;
  row.turnComplete = event.turnComplete;
  row.errorCode = event.errorCode;
  row.errorMessage = truncateStr(
    event.errorMessage,
    DEFAULT_MAX_VARCHAR_LENGTH,
  );
  row.interrupted = event.interrupted;
  row.content = jsonColumn(snakeCased, 'content');
  row.groundingMetadata = jsonColumn(snakeCased, 'grounding_metadata');
  row.customMetadata = jsonColumn(snakeCased, 'custom_metadata');
  row.usageMetadata = jsonColumn(snakeCased, 'usage_metadata');
  row.citationMetadata = jsonColumn(snakeCased, 'citation_metadata');
  row.inputTranscription = jsonColumn(snakeCased, 'input_transcription');
  row.outputTranscription = jsonColumn(snakeCased, 'output_transcription');
  setLongRunningToolIds(row, event.longRunningToolIds);
  return row;
}

/**
 * Decodes a row's pickled actions, or gives up on them.
 *
 * Losing a whole session's history to one unreadable blob is worse than losing
 * that event's actions, so a decode failure degrades to empty actions.
 */
function actionsOf(row: StorageEventV0) {
  if (!row.actions) {
    return createEventActions();
  }
  try {
    return loadEventActions(row.actions);
  } catch (error: unknown) {
    logger.warn(
      `Could not decode the pickled actions of event ${row.id}; reading it ` +
        `with empty actions. ${String(error)}`,
    );
    return createEventActions();
  }
}

/**
 * Converts a legacy row into an {@link Event}.
 *
 * The columns hold what adk-python's `model_dump(mode="json")` produced, so
 * the same snake_case transform the v1 JSON column uses applies here.
 *
 * Mirrors `StorageEvent.to_event` in adk-python's `schemas/v0.py`.
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
    long_running_tool_ids: longRunningToolIdsOf(row),
  });

  event.actions = actionsOf(row);
  return event;
}
