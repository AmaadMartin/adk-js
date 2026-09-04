/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  EntityClass,
  EntityData,
  EntityManager,
  Index,
  JsonType,
  ManyToOne,
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
import {
  createEventActions,
  serializeEventActions,
} from '../../events/event_actions.js';
import {isRecord, safeJsonLoads} from '../../utils/json_utils.js';
import {createSession, Session} from '../session.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  DynamicJsonType,
  PreciseTimestampType,
} from './shared.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
/**
 * The legacy schema written by adk-python before event data moved to JSON.
 * It stores event actions as a Python pickle, which this SDK cannot read.
 */
export const SCHEMA_VERSION_0_PICKLE = '0';
export const SCHEMA_VERSION_1_JSON = '1';
export const METADATA_TABLE_NAME = 'adk_internal_metadata';
export const EVENTS_TABLE_NAME = 'events';
export const STORAGE_KEY_COLUMN_LENGTH = 191;

/** The events column only the current layout has. */
export const EVENT_DATA_COLUMN_NAME = 'event_data';
/** The events column only the legacy layout has. */
export const EVENT_ACTIONS_COLUMN_NAME = 'actions';

/**
 * The index `getSession` and `appendEvent` read a session's events through.
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
    // A payload adk-python wrote can carry no `actions` at all, and MikroORM
    // runs this over such a payload to snapshot a row it has just read. The
    // field is only rewritten when the event has one, so the snapshot stays
    // equal to the stored text and the row does not read as modified.
    const actions = value.actions
      ? serializeEventActions(value.actions)
      : value.actions;
    return JSON.stringify(transformToSnakeCaseEvent({...value, actions}));
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
 *
 * It extends {@link DynamicJsonType}, so the column keeps the widest
 * JSON-capable declaration each backend supports.
 */
class StateJsonType extends DynamicJsonType {
  /**
   * @param context The column's role, for example `'session state'`, named in
   *   both error messages.
   */
  constructor(private readonly context: string) {
    super();
  }

  override convertToJSValue(value: unknown): Record<string, unknown> {
    // `DynamicJsonType` reports a parse failure against a fixed
    // `'session state'`. Each column names its own role instead.
    const decoded =
      typeof value === 'string'
        ? safeJsonLoads(value, this.context)
        : super.convertToJSValue(value);

    if (!isRecord(decoded)) {
      throw new Error(`Persisted ${this.context} must be a JSON object.`);
    }
    return decoded;
  }
}

@Entity({tableName: METADATA_TABLE_NAME})
export class StorageMetadata {
  @PrimaryKey({type: 'string'})
  key!: string;

  @Property({type: 'string', length: DEFAULT_MAX_VARCHAR_LENGTH})
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
    type: PreciseTimestampType,
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
    type: PreciseTimestampType,
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
    type: PreciseTimestampType,
    fieldName: 'create_time',
    onCreate: () => new Date(),
  })
  createTime: Date = new Date();

  @Property({
    type: PreciseTimestampType,
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: (row: StorageSession, em: EntityManager) =>
      nextSessionUpdateTime(row, em.getUnitOfWork().getOriginalEntityData(row)),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

/**
 * The value `sessions.update_time` takes on an update.
 *
 * adk-python declares `onupdate=func.now()`, which SQLAlchemy applies only to
 * an update that leaves the column alone; `append_event` assigns the column
 * itself and keeps its own value. MikroORM runs its `onUpdate` hook on every
 * update change set instead, so this compares the row against the snapshot it
 * was loaded with and keeps a value the caller assigned.
 */
function nextSessionUpdateTime(
  row: StorageSession,
  original: EntityData<StorageSession> | undefined,
): Date {
  return Number(original?.updateTime) === row.updateTime.getTime()
    ? new Date()
    : row.updateTime;
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
    `create index ${EVENTS_TIMESTAMP_INDEX_NAME} on ${EVENTS_TABLE_NAME} ` +
    `(app_name, user_id, session_id, timestamp desc)`,
})
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

  @Property({type: PreciseTimestampType})
  timestamp!: Date;

  /**
   * The serialized event, nullable as it is in adk-python's `v1.py`. A row
   * another writer produced can leave it empty.
   */
  @Property({
    type: CamelCaseToSnakeCaseJsonType,
    fieldName: 'event_data',
    nullable: true,
  })
  eventData!: Event | null;

  /**
   * The owning session, mapped onto the `app_name`, `user_id` and `session_id`
   * primary-key columns the scalar properties above already declare.
   *
   * It carries the `events -> sessions ON DELETE CASCADE` constraint
   * adk-python declares, so deleting a session row removes its events even when
   * the caller never goes through {@link StorageEvent}.
   *
   * Both column lists follow {@link StorageSession}'s primary-key order, and
   * must keep following it, for two reasons. MikroORM appends the relation to
   * the WHERE clause of every UPDATE and DELETE as a tuple, and builds the
   * right-hand side by serializing the referenced entity's primary key in its
   * declared order. A list in any other order compares the two sides
   * misaligned, so the statement matches no row and the write is dropped
   * without an error. InnoDB then only accepts a foreign key whose referenced
   * columns lead an index of the parent table, and that primary key is the
   * only index `sessions` has; MySQL 8.0 rejects any other order with errno
   * 1822. A foreign key pairs columns rather than ordering them, so this is
   * the constraint adk-python declares, written to fit the key adk-js
   * declares. The schema test pins the two column lists to each other.
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

/** The parts of a {@link Session} that do not live on the session row. */
export interface ToSessionOptions {
  /** The state merged from the app, user and session rows. */
  state: Record<string, unknown>;
  /** The session's events, oldest first. */
  events?: Event[];
  /**
   * The exact storage revision the caller read the row at, which
   * `DatabaseSessionService` compares against on the next write.
   */
  storageUpdateMarker?: string;
}

/**
 * The session row's update time, in milliseconds since the epoch.
 *
 * Mirrors adk-python's `get_update_timestamp`, which returns seconds. adk-js
 * measures `Session.lastUpdateTime` and `Event.timestamp` in milliseconds
 * throughout, so this keeps milliseconds.
 */
export function getUpdateTimestamp(row: StorageSession): number {
  return row.updateTime.getTime();
}

/**
 * Converts a session row into a {@link Session}.
 *
 * Mirrors adk-python's `StorageSession.to_session`.
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
    storageUpdateMarker: options.storageUpdateMarker,
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
 * A row whose `event_data` is null still yields an `Event`, carrying the
 * identity and timestamp the columns hold.
 */
export function storageEventToEvent(row: StorageEvent): Event {
  const eventData = row.eventData;
  return {
    ...eventData,
    actions: createEventActions(eventData?.actions),
    id: row.id,
    invocationId: row.invocationId,
    timestamp: eventData?.timestamp ?? row.timestamp.getTime(),
  };
}

/**
 * The entity set `DatabaseSessionService` registers.
 *
 * A caller who builds their own `MikroORM` instance to hand to the service has
 * to register these, because the service cannot change the entity set of an
 * instance it did not open.
 */
export const ENTITIES: Array<EntityClass<object>> = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];
