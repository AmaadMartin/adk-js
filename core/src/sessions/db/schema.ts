/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Cascade,
  Collection,
  Entity,
  EntityManager,
  Index,
  JsonType,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  Ref,
  RequiredEntityData,
} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {createSession, Session} from '../session.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';
export const STORAGE_KEY_COLUMN_LENGTH = 191;

/** The index `getSession` and `appendEvent` read a session's events through. */
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
    onUpdate: (row: StorageSession, em: EntityManager) =>
      hasAssignedUpdateTime(em, row) ? row.updateTime : new Date(),
  })
  updateTime: Date = new Date();

  @OneToMany(() => StorageEvent, (event) => event.storageSession, {
    orphanRemoval: true,
    cascade: [Cascade.ALL],
  })
  storageEvents = new Collection<StorageEvent>(this);

  [PrimaryKey.name]?: [string, string, string];
}

/**
 * MikroORM emits an `expression` index verbatim as its DDL statement, which is
 * the only way to get the descending `timestamp` component adk-python declares;
 * `properties` would produce an ascending index. The identifiers are unquoted
 * because the quote character differs per dialect and MikroORM does not rewrite
 * the expression.
 */
@Index({
  name: EVENTS_TIMESTAMP_INDEX_NAME,
  expression:
    `create index ${EVENTS_TIMESTAMP_INDEX_NAME} on events ` +
    `(app_name, user_id, session_id, timestamp desc)`,
})
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

  /**
   * The owning session, mapped onto the `app_name`, `user_id` and `session_id`
   * primary-key columns the scalar properties above already declare.
   *
   * It carries the `events -> sessions ON DELETE CASCADE` constraint
   * adk-python declares, so deleting a session row removes its events even when
   * the caller never goes through {@link StorageEvent}.
   *
   * Both column lists follow {@link StorageSession}'s primary-key order, and
   * must keep following it. MikroORM appends the relation to the WHERE clause
   * of every UPDATE and DELETE as a tuple, and builds the right-hand side by
   * serializing the referenced entity's primary key in its declared order. A
   * list in any other order compares the two sides misaligned, so the
   * statement matches no row and the write is dropped without an error.
   *
   * A database that already exists keeps its old tables: `updateSchema({safe:
   * true})` adds the index but cannot add the constraint on sqlite, which has
   * no `ALTER TABLE ADD CONSTRAINT`. Those databases still rely on
   * `DatabaseSessionService.deleteSession` deleting the event rows itself.
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

  [PrimaryKey.name]?: [string, string, string, string];
}

/**
 * Reports whether the caller assigned `updateTime` since the row was loaded.
 *
 * SQLAlchemy applies `onupdate` only to columns the UPDATE statement does not
 * already set, so an explicit assignment wins. MikroORM runs the hook
 * unconditionally and overwrites whatever the caller assigned, so the hook has
 * to make that check itself.
 *
 * MikroORM snapshots a datetime column as the `Date` it hydrated on load, and
 * as whatever `Platform.processDateProperty` returns after a flush — epoch
 * milliseconds on sqlite. Both forms compare as an epoch.
 */
function hasAssignedUpdateTime(
  em: EntityManager,
  row: StorageSession,
): boolean {
  const loaded = em.getUnitOfWork().getOriginalEntityData(row)?.updateTime;
  const loadedEpoch =
    loaded instanceof Date ? loaded.getTime() : Number(loaded);
  return loadedEpoch !== row.updateTime.getTime();
}

/**
 * Returns the session's last update time in milliseconds since the epoch.
 *
 * adk-python's `StorageSession.get_update_timestamp` returns seconds; adk-js
 * measures `Session.lastUpdateTime` and `Event.timestamp` in milliseconds
 * throughout, so this keeps milliseconds.
 */
export function getUpdateTimestamp(row: StorageSession): number {
  return row.updateTime.getTime();
}

/**
 * Returns a stable revision marker for optimistic concurrency checks.
 *
 * adk-python's `StorageSession.get_update_marker` formats with microsecond
 * precision and keeps a naive value naive. A JS `Date` has neither a naive form
 * nor microseconds, so the marker is always the UTC ISO-8601 rendering at
 * millisecond precision.
 */
export function getUpdateMarker(row: StorageSession): string {
  return row.updateTime.toISOString();
}

/** Optional parts of a {@link Session} that do not live on the session row. */
export interface ToSessionOptions {
  /** The state merged from the app, user and session rows. */
  state?: Record<string, unknown>;
  /** The session's events, oldest first. */
  events?: Event[];
}

/**
 * Converts a session row into a {@link Session}.
 *
 * Mirrors adk-python's `StorageSession.to_session`.
 */
export function toSession(
  row: StorageSession,
  options: ToSessionOptions = {},
): Session {
  return createSession({
    id: row.id,
    appName: row.appName,
    userId: row.userId,
    state: options.state ?? {},
    events: options.events ?? [],
    lastUpdateTime: getUpdateTimestamp(row),
    storageUpdateMarker: getUpdateMarker(row),
  });
}

/**
 * Builds the row for an event.
 *
 * adk-python's `StorageEvent.from_event` takes the `Session`; this takes the
 * loaded `StorageSession` instead, because the row is what populates the
 * `storageSession` relation. Leaving that relation unset lets MikroORM's
 * snapshot comparator write a null over the foreign-key columns.
 */
export function storageEventFromEvent(
  storageSession: StorageSession,
  event: Event,
): RequiredEntityData<StorageEvent> {
  return {
    id: event.id,
    appName: storageSession.appName,
    userId: storageSession.userId,
    sessionId: storageSession.id,
    invocationId: event.invocationId,
    timestamp: new Date(event.timestamp),
    eventData: event,
    storageSession,
  };
}

/**
 * Converts an event row into an {@link Event}.
 *
 * Mirrors adk-python's `StorageEvent.to_event`. The stored payload already
 * carries the event's exact epoch, so it wins over the `timestamp` column: that
 * column holds a local datetime on some dialects, and rebuilding an epoch from
 * it resolves an ambiguous local time — a daylight-saving fall-back repeats a
 * whole hour — to the wrong instant.
 *
 * `event_data` is nullable in adk-python, so a row another writer produced can
 * read back as null here even though the column is declared NOT NULL.
 */
export function storageEventToEvent(row: StorageEvent): Event {
  const eventData: Partial<Event> = row.eventData ?? {};
  return {
    ...eventData,
    actions: createEventActions(eventData.actions),
    id: row.id,
    invocationId: row.invocationId,
    timestamp: eventData.timestamp ?? row.timestamp.getTime(),
  };
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
