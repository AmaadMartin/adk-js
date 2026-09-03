/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The legacy v0 session schema, written by adk-python 1.19.0 through 1.21.0.
 *
 * It spreads an event over flat columns and stores `EventActions` as a Python
 * pickle. The current schema is in `schema.ts`, which keeps the whole event as
 * one JSON document. The two entity sets claim the same table names, so a
 * `MikroORM` instance registers one of them, never both.
 */

import type {
  CitationMetadata,
  Content,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Transcription,
} from '@google/genai';
import {Entity, PrimaryKey, Property} from '@mikro-orm/core';
import {createEvent, Event} from '../../events/event.js';
import {
  DATETIME_FRACTIONAL_DIGITS,
  EVENTS_TABLE_NAME,
  STORAGE_KEY_COLUMN_LENGTH,
} from './schema.js';

@Entity({tableName: 'app_states'})
export class StorageAppStateV0 {
  @PrimaryKey({
    type: 'string',
    fieldName: 'app_name',
    length: STORAGE_KEY_COLUMN_LENGTH,
  })
  appName!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'update_time',
  })
  updateTime: Date = new Date();
}

@Entity({tableName: 'user_states'})
export class StorageUserStateV0 {
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

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'update_time',
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string];
}

@Entity({tableName: 'sessions'})
export class StorageSessionV0 {
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

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'create_time',
  })
  createTime: Date = new Date();

  @Property({
    type: 'datetime',
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'update_time',
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

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

  @Property({type: 'datetime', length: DATETIME_FRACTIONAL_DIGITS})
  timestamp!: Date;

  /**
   * A Python pickle of the event's `EventActions`.
   *
   * Mapped so that the column is part of the entity, and never decoded: the
   * value is a pickled graph of pydantic models that only adk-python can read.
   */
  @Property({type: 'blob', nullable: true})
  actions?: Buffer;

  @Property({
    type: 'text',
    fieldName: 'long_running_tool_ids_json',
    nullable: true,
  })
  longRunningToolIdsJson?: string;

  @Property({type: 'json', nullable: true})
  content?: Content;

  @Property({type: 'json', fieldName: 'grounding_metadata', nullable: true})
  groundingMetadata?: GroundingMetadata;

  @Property({type: 'json', fieldName: 'custom_metadata', nullable: true})
  customMetadata?: Record<string, unknown>;

  @Property({type: 'json', fieldName: 'usage_metadata', nullable: true})
  usageMetadata?: GenerateContentResponseUsageMetadata;

  @Property({type: 'json', fieldName: 'citation_metadata', nullable: true})
  citationMetadata?: CitationMetadata;

  @Property({type: 'json', fieldName: 'input_transcription', nullable: true})
  inputTranscription?: Transcription;

  @Property({type: 'json', fieldName: 'output_transcription', nullable: true})
  outputTranscription?: Transcription;

  @Property({type: 'boolean', nullable: true})
  partial?: boolean;

  @Property({type: 'boolean', fieldName: 'turn_complete', nullable: true})
  turnComplete?: boolean;

  @Property({type: 'boolean', nullable: true})
  interrupted?: boolean;

  @Property({type: 'string', fieldName: 'error_code', nullable: true})
  errorCode?: string;

  @Property({type: 'text', fieldName: 'error_message', nullable: true})
  errorMessage?: string;

  [PrimaryKey.name]?: [string, string, string, string];
}

/** The entity set a legacy v0 database is read through. */
export const ENTITIES_V0 = [
  StorageAppStateV0,
  StorageUserStateV0,
  StorageSessionV0,
  StorageEventV0,
];

/** Parses the JSON array v0 stores the long-running tool ids in. */
function parseLongRunningToolIds(json?: string): string[] {
  if (!json) {
    return [];
  }
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/**
 * Rebuilds an {@link Event} from a legacy v0 row.
 *
 * Mirrors `StorageEvent.to_event` in adk-python's `sessions/schemas/v0.py`.
 * The `actions` column is left out: it holds a Python pickle, so the event
 * comes back with empty actions.
 *
 * @param row The stored v0 event row.
 */
export function storageEventV0ToEvent(row: StorageEventV0): Event {
  return createEvent({
    id: row.id,
    invocationId: row.invocationId,
    author: row.author,
    branch: row.branch,
    timestamp: row.timestamp.getTime(),
    longRunningToolIds: parseLongRunningToolIds(row.longRunningToolIdsJson),
    content: row.content,
    groundingMetadata: row.groundingMetadata,
    customMetadata: row.customMetadata,
    usageMetadata: row.usageMetadata,
    citationMetadata: row.citationMetadata,
    inputTranscription: row.inputTranscription,
    outputTranscription: row.outputTranscription,
    partial: row.partial,
    turnComplete: row.turnComplete,
    interrupted: row.interrupted,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  });
}
