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
 * The `events` table adk-python wrote before event data moved to one JSON
 * column, mirroring its `schemas/v0.py` column for column.
 *
 * The `sessions`, `app_states` and `user_states` tables are the same in both
 * schema versions, so only this entity is duplicated. `actions` holds a Python
 * pickle, which is why the service opens such a database for reading only.
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

  /** A Python pickle of the event's actions. */
  @Property({type: 'blob', nullable: true})
  actions?: Buffer;

  @Property({
    type: 'text',
    fieldName: 'long_running_tool_ids_json',
    nullable: true,
  })
  longRunningToolIdsJson?: string;

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

  @Property({type: 'json', fieldName: 'input_transcription', nullable: true})
  inputTranscription?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'output_transcription', nullable: true})
  outputTranscription?: Record<string, unknown>;

  [PrimaryKey.name]?: [string, string, string, string];
}

/**
 * The entity set of a legacy database.
 *
 * `StorageMetadata` is absent because a v0 database has no such table, and
 * `StorageEvent` is absent because `StorageEventV0` maps the same table.
 */
export const ENTITIES_V0 = [
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEventV0,
];

/** Reads the stored tool id list, which adk-python writes as a JSON array. */
function parseLongRunningToolIds(json?: string): string[] | undefined {
  return json ? (JSON.parse(json) as string[]) : undefined;
}

/**
 * Rebuilds an event from a legacy row.
 *
 * The JSON columns hold adk-python's `model_dump(mode="json")` output, which
 * is snake_case throughout, so the row is assembled in that shape and handed
 * to the converter the v1 payloads already go through.
 *
 * `actions` comes back empty: the column is a Python pickle, which this SDK
 * cannot read.
 *
 * @param row The legacy row to convert.
 */
export function storageEventV0ToEvent(row: StorageEventV0): Event {
  return transformToCamelCaseEvent({
    id: row.id,
    invocation_id: row.invocationId,
    author: row.author,
    branch: row.branch,
    // `Event.timestamp` is milliseconds in adk-js, which is what a Date
    // already reports. adk-python stores seconds and converts on the way out.
    timestamp: row.timestamp.getTime(),
    long_running_tool_ids: parseLongRunningToolIds(row.longRunningToolIdsJson),
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
    // The pickled column cannot be read here, so the event carries the empty
    // actions adk-python's own `EventActions()` default would give it.
    actions: createEventActions(),
  });
}
