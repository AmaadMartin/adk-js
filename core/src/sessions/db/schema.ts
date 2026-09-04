/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Entity, JsonType, PrimaryKey, Property} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {createSession, Session} from '../session.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';
export const STORAGE_KEY_COLUMN_LENGTH = 191;
export const EVENTS_TABLE_NAME = 'events';

/**
 * The length adk-python gives every `VARCHAR` column that is not a key.
 *
 * adk-js declares those columns as text, so this is only the width a value has
 * to fit for a database that still carries the older declaration.
 */
export const DEFAULT_MAX_VARCHAR_LENGTH = 256;

/**
 * The index a session's events are read through.
 *
 * The name is the one adk-python declares. Both SDKs read the same database,
 * so sharing the name stops the two of them creating two indexes for one
 * access path.
 */
export const EVENTS_TIMESTAMP_INDEX_NAME = 'idx_events_app_user_session_ts';

/**
 * Custom type for serializing and deserializing ADK Event objects.
 *
 * This type handles the conversion between camelCase (TypeScript ADK) and
 * snake_case (Python ADK) for Event objects, ensuring that nested
 * properties are converted correctly while preserving specific keys.
 */
class CamelCaseToSnakeCaseJsonType extends JsonType {
  convertToDatabaseValue(value: Event): string {
    return JSON.stringify(transformToSnakeCaseEvent(value));
  }

  convertToJSValue(value: string | Record<string, unknown>): Event {
    if (typeof value === 'string') {
      return transformToCamelCaseEvent(JSON.parse(value));
    }

    return transformToCamelCaseEvent(value);
  }
}

@Entity({tableName: 'adk_internal_metadata'})
export class StorageMetadata {
  @PrimaryKey({type: 'string'})
  key!: string;

  @Property({type: 'string'})
  value!: string;
}

@Entity({tableName: 'app_states'})
export class StorageAppState {
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
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime: Date = new Date();
}

@Entity({tableName: 'user_states'})
export class StorageUserState {
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
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string];
}

@Entity({tableName: 'sessions'})
export class StorageSession {
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
    fieldName: 'create_time',
    onCreate: () => new Date(),
  })
  createTime: Date = new Date();

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

@Entity({tableName: EVENTS_TABLE_NAME})
export class StorageEvent {
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

  @Property({type: 'datetime'})
  timestamp!: Date;

  @Property({type: CamelCaseToSnakeCaseJsonType, fieldName: 'event_data'})
  eventData!: Event;

  [PrimaryKey.name]?: [string, string, string, string];
}

/*
 * Export entities for Mikro-ORM configuration
 */
export const ENTITIES = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];

/**
 * Returns the time a session row was last written, in milliseconds.
 *
 * adk-python's `StorageSession.get_update_timestamp` returns POSIX seconds and
 * has to read a naive column value as UTC by hand. A driver hands MikroORM a
 * `Date`, which already names an instant, so there is nothing to correct here.
 * adk-python's `update_timestamp_tz` returns the same value, so it has no
 * counterpart of its own.
 */
export function getUpdateTimestamp(row: StorageSession): number {
  return row.updateTime.getTime();
}

/**
 * Returns the revision marker for a session row.
 *
 * The marker is compared for exact equality against the marker rebuilt from a
 * later read of the same row, so it only has to be stable and normalized to
 * UTC. adk-python renders microseconds; a `Date` holds milliseconds, so this
 * renders what the column can round-trip.
 */
export function getUpdateMarker(row: StorageSession): string {
  return row.updateTime.toISOString();
}

/** The parts of a {@link Session} that do not live on the session row. */
export interface ToSessionOptions {
  /** The state merged from the app, user and session rows. */
  state: Record<string, unknown>;
  /** The session's events, oldest first. */
  events?: Event[];
  /**
   * The exact storage revision the caller read the row at. It defaults to the
   * marker of the row itself.
   */
  storageUpdateMarker?: string;
}

/**
 * Converts a session row into a {@link Session}.
 *
 * Mirrors adk-python's `StorageSession.to_session`. adk-js measures
 * `Session.lastUpdateTime` in milliseconds throughout, so `lastUpdateTime`
 * keeps milliseconds where adk-python returns seconds.
 */
export function toSession(
  row: StorageSession,
  options: ToSessionOptions,
): Session {
  return createSession({
    id: row.id,
    appName: row.appName,
    userId: row.userId,
    state: options.state,
    events: options.events ?? [],
    lastUpdateTime: getUpdateTimestamp(row),
    storageUpdateMarker: options.storageUpdateMarker ?? getUpdateMarker(row),
  });
}
