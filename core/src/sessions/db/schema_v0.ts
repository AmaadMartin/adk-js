/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Entity, PrimaryKey, Property} from '@mikro-orm/core';
import {Event, transformToCamelCaseEvent} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {
  EVENTS_TABLE_NAME,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageAppState,
  StorageSession,
  StorageUserState,
} from './schema.js';

/**
 * The `events` table as adk-python wrote it before the v1 schema.
 *
 * It spreads an event across typed columns instead of the single JSON
 * `event_data` column {@link StorageEvent} uses. adk-js reads such a table but
 * never creates or writes one, because `actions` holds a Python pickle.
 *
 * Mirrors `src/google/adk/sessions/schemas/v0.py` in adk-python.
 */
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

  /**
   * A Python pickle of the event's actions. The column is mapped so the row
   * loads, and is never decoded: no TypeScript reader can unpickle it.
   */
  @Property({type: 'blob', nullable: true})
  actions?: Buffer;

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
 * Converts a legacy row into an {@link Event}.
 *
 * The columns hold what adk-python's `model_dump(mode="json")` produced, so
 * the same snake_case transform the v1 JSON column uses applies here. Actions
 * come back empty, matching adk-python's `EventActions()` default, because the
 * pickle in the `actions` column cannot be decoded.
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
      ? JSON.parse(row.longRunningToolIdsJson)
      : undefined,
  });

  event.actions = createEventActions();
  return event;
}
