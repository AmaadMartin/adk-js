/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  JsonType,
  Platform,
  PrimaryKey,
  Property,
  TransformContext,
} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {isRecord, safeJsonLoads} from '../../utils/json_utils.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';
export const STORAGE_KEY_COLUMN_LENGTH = 191;

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

/**
 * Storage type for a state column, decoded defensively.
 *
 * A state column is plain JSON in the database, so another tool — or a
 * hand-edit — can leave text behind that is not the object the merge expects.
 * Both failures are reported against the column's role instead of surfacing a
 * bare parser error or spreading an array into index keys.
 *
 * This is adk-python's `sqlite_session_service._decode_state`. Python rejects
 * a non-string key as well; a `JSON.parse` result can only have string keys,
 * so that branch has no counterpart here.
 */
class StateJsonType extends JsonType {
  /**
   * @param context The column's role, for example `'session state'`, named in
   *   both error messages.
   */
  constructor(private readonly context: string) {
    super();
  }

  override convertToJSValue(
    value: unknown,
    platform: Platform,
    context?: TransformContext,
  ): Record<string, unknown> {
    const decoded =
      typeof value === 'string'
        ? safeJsonLoads(value, this.context)
        : super.convertToJSValue(value, platform, context);

    if (!isRecord(decoded)) {
      throw new Error(`Persisted ${this.context} must be a JSON object.`);
    }
    return decoded;
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

  @Property({type: new StateJsonType('app state')})
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

  @Property({type: new StateJsonType('user state')})
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

  @Property({type: new StateJsonType('session state')})
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

@Entity({tableName: 'events'})
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
