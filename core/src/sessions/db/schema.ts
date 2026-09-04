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
 * Widest value a legacy `VARCHAR` event column accepts.
 *
 * Mirrors `DEFAULT_MAX_VARCHAR_LENGTH` in adk-python's
 * `src/google/adk/sessions/schemas/shared.py`.
 */
export const DEFAULT_MAX_VARCHAR_LENGTH = 256;

/**
 * Fractional-second digits a stored timestamp column keeps.
 *
 * MySQL and MariaDB default a `DATETIME` column to whole seconds, which would
 * round away the millisecond an `Event.timestamp` carries. adk-python asks for
 * six digits; a JavaScript `Date` holds three.
 */
export const DATETIME_FRACTIONAL_DIGITS = 3;

/**
 * Name of the index over the event lookup columns, matching adk-python.
 *
 * Both SDKs read the same database, so sharing the name stops the two of them
 * creating two indexes for one access path.
 */
export const EVENTS_SESSION_TIMESTAMP_INDEX = 'idx_events_app_user_session_ts';

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

  /**
   * Returns the update time in milliseconds since the epoch.
   *
   * adk-python returns POSIX seconds here. adk-js carries
   * {@link Session.lastUpdateTime} in milliseconds throughout, so the port
   * keeps milliseconds: converting would corrupt every staleness comparison
   * that already reads this value.
   */
  getUpdateTimestamp(): number {
    return this.updateTime.getTime();
  }

  /**
   * Returns a stable revision marker for optimistic-concurrency checks.
   *
   * A marker is only ever compared for equality against another marker made
   * the same way, so its format is adk-js's own: an ISO-8601 instant in UTC,
   * to the millisecond a `Date` holds.
   */
  getUpdateMarker(): string {
    return this.updateTime.toISOString();
  }

  /** Converts the stored row into a {@link Session}. */
  toSession(
    state: Record<string, unknown> = {},
    events: Event[] = [],
  ): Session {
    return createSession({
      appName: this.appName,
      userId: this.userId,
      id: this.id,
      state,
      events,
      lastUpdateTime: this.getUpdateTimestamp(),
      storageUpdateMarker: this.getUpdateMarker(),
    });
  }
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
