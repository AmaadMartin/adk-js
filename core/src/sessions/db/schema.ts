/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  Index,
  JsonType,
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

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';
export const STORAGE_KEY_COLUMN_LENGTH = 191;
/**
 * Fractional-second digits every stored timestamp column keeps.
 *
 * MySQL and MariaDB default a `DATETIME` column to whole seconds, which would
 * round away the millisecond an `Event.timestamp` carries. The stale-session
 * marker and the event ordering both compare those values, so the column has
 * to hold what the caller wrote.
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
    length: DATETIME_FRACTIONAL_DIGITS,
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
    length: DATETIME_FRACTIONAL_DIGITS,
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
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'create_time',
    onCreate: () => new Date(),
  })
  createTime: Date = new Date();

  @Property({
    type: 'datetime',
    length: DATETIME_FRACTIONAL_DIGITS,
    fieldName: 'update_time',
    onCreate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

@Entity({tableName: 'events'})
@Index({
  name: EVENTS_SESSION_TIMESTAMP_INDEX,
  properties: ['appName', 'userId', 'sessionId', 'timestamp'],
})
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

  @Property({type: 'datetime', length: DATETIME_FRACTIONAL_DIGITS})
  timestamp!: Date;

  @Property({type: CamelCaseToSnakeCaseJsonType, fieldName: 'event_data'})
  eventData!: Event;

  /**
   * The session this event belongs to, read through the key columns above.
   *
   * This relation carries the `ON DELETE CASCADE` foreign key, so a deleted
   * session takes its events with it. `ownColumns: []` leaves `appName`,
   * `userId` and `sessionId` owning their columns, because they are primary
   * keys that callers set by name; assigning this relation does not set them.
   *
   * The referenced columns are listed in the order of the `sessions` primary
   * key. InnoDB only accepts a foreign key whose referenced columns lead an
   * index of the parent table, and that primary key is the only index
   * `sessions` has; MySQL 8.0 rejects any other order with errno 1822. A
   * foreign key pairs columns rather than ordering them, so this is the
   * constraint adk-python declares, written to fit the key adk-js declares.
   * The schema test pins the two column lists to each other.
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
