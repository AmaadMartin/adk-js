/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python's
 * `tests/unittests/sessions/test_v0_storage_event.py`, plus the schema
 * assertions the reference gets from SQLAlchemy's own metadata. Each ported
 * test keeps the reference test's name.
 */

import {Content} from '@google/genai';
import {MikroORM} from '@mikro-orm/core';
import {MySqlPlatform} from '@mikro-orm/knex';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createEvent, Event} from '../../../src/events/event.js';
import {createEventActions} from '../../../src/events/event_actions.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  EVENTS_TIMESTAMP_INDEX_NAME,
  StorageSession,
} from '../../../src/sessions/db/schema.js';
import {
  ENTITIES_V0,
  pickleBlobColumnType,
  PickleBlobType,
  StorageEventV0,
  storageEventV0FromEvent,
  storageEventV0ToEvent,
  truncateStr,
  TRUNCATION_SUFFIX,
} from '../../../src/sessions/db/schema_v0.js';
import {logger} from '../../../src/utils/logger.js';

// The drivers below are optional peers, so a test run may not have them.
vi.mock('@mikro-orm/postgresql', () => ({
  PostgreSqlDriver: class MockPostgreSqlDriver {},
}));
vi.mock('@mikro-orm/mysql', () => ({
  MySqlDriver: class MockMySqlDriver {},
}));

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session_id';

function sessionRow(): StorageSession {
  const row = new StorageSession();
  row.appName = APP_NAME;
  row.userId = USER_ID;
  row.id = SESSION_ID;
  row.state = {};
  row.createTime = new Date(0);
  row.updateTime = new Date(0);
  return row;
}

async function openLegacyDatabase(): Promise<MikroORM> {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    driver: SqliteDriver,
    entities: ENTITIES_V0,
  });
  await orm.schema.createSchema();
  return orm;
}

describe('truncateStr', () => {
  it('test_truncate_str_returns_none_for_none', () => {
    expect(truncateStr(undefined, DEFAULT_MAX_VARCHAR_LENGTH)).toBeUndefined();
  });

  it('test_truncate_str_returns_short_string_unchanged', () => {
    expect(truncateStr('short message', DEFAULT_MAX_VARCHAR_LENGTH)).toBe(
      'short message',
    );
  });

  it('test_truncate_str_returns_exact_length_string_unchanged', () => {
    const exact = 'a'.repeat(DEFAULT_MAX_VARCHAR_LENGTH);

    expect(truncateStr(exact, DEFAULT_MAX_VARCHAR_LENGTH)).toBe(exact);
  });

  it('test_truncate_str_truncates_long_string', () => {
    const result = truncateStr('x'.repeat(1000), DEFAULT_MAX_VARCHAR_LENGTH);

    expect(result).toHaveLength(DEFAULT_MAX_VARCHAR_LENGTH);
    expect(result?.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('warns with both lengths when it truncates', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      truncateStr('x'.repeat(1000), DEFAULT_MAX_VARCHAR_LENGTH);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('from 1000 to 256 characters');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the value already fits', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      truncateStr('short', DEFAULT_MAX_VARCHAR_LENGTH);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('storageEventV0FromEvent', () => {
  it('test_from_event_truncates_long_error_message', () => {
    const event = createEvent({
      id: 'event_id',
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: 1,
      errorCode: 'MALFORMED_FUNCTION_CALL',
      errorMessage: `Malformed function call: ${'a'.repeat(1000)}`,
    });

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.errorMessage).toHaveLength(DEFAULT_MAX_VARCHAR_LENGTH);
    expect(String(row.errorMessage).endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(row.errorCode).toBe('MALFORMED_FUNCTION_CALL');
  });

  it('test_from_event_preserves_short_error_message', () => {
    const event = createEvent({
      id: 'event_id',
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: 1,
      errorCode: 'SOME_ERROR',
      errorMessage: 'Something went wrong',
    });

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.errorMessage).toBe('Something went wrong');
  });

  it('test_storage_event_v0_timestamp_round_trip_uses_utc', () => {
    const event = createEvent({author: 'agent', timestamp: 1000});

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.timestamp).toEqual(new Date('1970-01-01T00:00:01.000Z'));
  });

  it('copies the identity of the session row it is given', () => {
    const event = createEvent({author: 'agent', timestamp: 1});

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.appName).toBe(APP_NAME);
    expect(row.userId).toBe(USER_ID);
    expect(row.sessionId).toBe(SESSION_ID);
    expect(row.storageSession).toBeDefined();
  });

  it('leaves a column null when the event has nothing for it', () => {
    const event = createEvent({author: 'agent', timestamp: 1});

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.content).toBeUndefined();
    expect(row.groundingMetadata).toBeUndefined();
    expect(row.customMetadata).toBeUndefined();
    expect(row.usageMetadata).toBeUndefined();
    expect(row.citationMetadata).toBeUndefined();
    expect(row.inputTranscription).toBeUndefined();
    expect(row.outputTranscription).toBeUndefined();
    expect(row.errorMessage).toBeUndefined();
  });

  it('writes each JSON column in the snake_case form adk-python reads', () => {
    const content: Content = {role: 'user', parts: [{text: 'hello'}]};
    const event = createEvent({
      author: 'agent',
      timestamp: 1,
      content,
      customMetadata: {source_id: 'keep_me'},
      usageMetadata: {promptTokenCount: 7},
    });

    const row = storageEventV0FromEvent(sessionRow(), event);

    expect(row.content).toEqual({role: 'user', parts: [{text: 'hello'}]});
    // `customMetadata` is user data, so its keys survive verbatim.
    expect(row.customMetadata).toEqual({source_id: 'keep_me'});
    expect(row.usageMetadata).toEqual({prompt_token_count: 7});
  });

  it('writes an empty author for an event that has none', () => {
    const event = createEvent({timestamp: 1});

    expect(storageEventV0FromEvent(sessionRow(), event).author).toBe('');
  });
});

describe('storageEventV0ToEvent', () => {
  it('decodes the actions the row carries', () => {
    const actions = createEventActions({
      stateDelta: {'user:name': 'Ada'},
      transferToAgent: 'analyst',
    });
    const row = new StorageEventV0();
    Object.assign(row, {
      id: 'event_id',
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: new Date(1000),
      actions: storageEventV0FromEvent(
        sessionRow(),
        createEvent({author: 'agent', timestamp: 1000, actions}),
      ).actions,
    });

    const event = storageEventV0ToEvent(row);

    expect(event.actions.stateDelta).toEqual({'user:name': 'Ada'});
    expect(event.actions.transferToAgent).toBe('analyst');
    expect(event.timestamp).toBe(1000);
  });

  it('gives an event default actions when the column is null', () => {
    const row = new StorageEventV0();
    Object.assign(row, {
      id: 'event_id',
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: new Date(1000),
    });

    expect(storageEventV0ToEvent(row).actions).toEqual(createEventActions());
  });
});

describe('StorageEventV0.longRunningToolIds', () => {
  it('reads an empty list when the column is null', () => {
    expect(new StorageEventV0().longRunningToolIds).toEqual([]);
  });

  it('writes the column through the setter and reads it back', () => {
    const row = new StorageEventV0();

    row.longRunningToolIds = ['call-1', 'call-2'];

    expect(row.longRunningToolIdsJson).toBe('["call-1","call-2"]');
    expect(row.longRunningToolIds).toEqual(['call-1', 'call-2']);
  });

  it('clears the column when the setter is given nothing', () => {
    const row = new StorageEventV0();
    row.longRunningToolIds = ['call-1'];

    row.longRunningToolIds = undefined;

    expect(row.longRunningToolIdsJson).toBeUndefined();
    expect(row.longRunningToolIds).toEqual([]);
  });
});

describe('pickleBlobColumnType', () => {
  it('widens the column to LONGBLOB on MySQL', () => {
    expect(pickleBlobColumnType(new MySqlPlatform())).toBe('longblob');
  });

  it('widens the column to LONGBLOB on MariaDB', () => {
    // MariaDbPlatform ships in a driver package this repository does not
    // install, so the platform is described by the two values it returns.
    const mariaDb = {
      getDefaultCharset: () => 'utf8mb4',
      getBlobDeclarationSQL: () => 'blob',
    };

    expect(pickleBlobColumnType(mariaDb)).toBe('longblob');
  });

  it.each([
    ['sqlite', 'utf8', 'blob'],
    ['postgresql', 'utf8', 'bytea'],
    ['mssql', 'utf8', 'varbinary(max)'],
  ])('keeps the %s blob column as declared', (_name, charset, blob) => {
    const platform = {
      getDefaultCharset: () => charset,
      getBlobDeclarationSQL: () => blob,
    };

    expect(pickleBlobColumnType(platform)).toBe(blob);
  });
});

describe('PickleBlobType', () => {
  const type = new PickleBlobType();

  it('converts a payload to a buffer and back', () => {
    const payload = Uint8Array.from([1, 2, 3]);

    const stored = type.convertToDatabaseValue(payload);

    expect(stored).toEqual(Buffer.from(payload));
    // A `Buffer` already is a `Uint8Array`, so the read direction hands the
    // driver's buffer straight back rather than copying it.
    expect([...(type.convertToJSValue(stored) ?? [])]).toEqual([1, 2, 3]);
  });

  it('keeps a null column null in both directions', () => {
    expect(type.convertToDatabaseValue(null)).toBeNull();
    expect(type.convertToJSValue(null)).toBeNull();
  });
});

describe('a legacy sqlite database', () => {
  let orm: MikroORM | undefined;

  afterEach(async () => {
    await orm?.close();
    orm = undefined;
  });

  it('declares the actions column with the platform default', async () => {
    orm = await openLegacyDatabase();

    const createTable = await orm.schema.getCreateSchemaSQL();

    expect(createTable).toMatch(/`actions` blob null/);
  });

  it('declares the event index adk-python declares', async () => {
    orm = await openLegacyDatabase();

    const createTable = await orm.schema.getCreateSchemaSQL();

    expect(createTable).toContain(
      `create index ${EVENTS_TIMESTAMP_INDEX_NAME} on events ` +
        `(app_name, user_id, session_id, timestamp desc)`,
    );
  });

  it('declares the cascade with the session primary key column order', async () => {
    orm = await openLegacyDatabase();

    const createTable = await orm.schema.getCreateSchemaSQL();

    expect(createTable).toContain(
      'foreign key(`session_id`, `app_name`, `user_id`) references ' +
        '`sessions`(`id`, `app_name`, `user_id`) on delete cascade',
    );
  });

  it('keeps the long-running tool ids in their json column only', async () => {
    orm = await openLegacyDatabase();

    const createTable = await orm.schema.getCreateSchemaSQL();

    expect(createTable).toContain('`long_running_tool_ids_json` text null');
    expect(createTable).not.toContain('`long_running_tool_ids`');
  });

  it('round-trips an event, actions and all', async () => {
    orm = await openLegacyDatabase();
    const em = orm.em.fork();
    const storageSession = em.create(StorageSession, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: {},
      createTime: new Date(1000),
      updateTime: new Date(1000),
    });
    const event: Event = createEvent({
      id: 'event_id',
      invocationId: 'inv_id',
      author: 'agent',
      branch: 'root',
      timestamp: 1000,
      content: {role: 'user', parts: [{text: 'hello'}]},
      longRunningToolIds: ['call-1'],
      partial: false,
      turnComplete: true,
      errorCode: 'SOME_ERROR',
      errorMessage: 'Something went wrong',
      interrupted: false,
      actions: createEventActions({
        stateDelta: {'user:name': 'Ada', count: 3},
        artifactDelta: {'report.txt': 2},
        transferToAgent: 'analyst',
        escalate: true,
      }),
    });
    em.create(StorageEventV0, storageEventV0FromEvent(storageSession, event));
    await em.flush();

    const stored = await orm.em
      .fork()
      .findOneOrFail(StorageEventV0, {id: 'event_id'});
    const readBack = storageEventV0ToEvent(stored);

    expect(readBack.actions).toEqual(event.actions);
    expect(readBack.content).toEqual(event.content);
    expect(readBack.longRunningToolIds).toEqual(['call-1']);
    expect(readBack.branch).toBe('root');
    expect(readBack.timestamp).toBe(1000);
    expect(readBack.errorCode).toBe('SOME_ERROR');
    expect(readBack.errorMessage).toBe('Something went wrong');
    expect(readBack.partial).toBe(false);
    expect(readBack.turnComplete).toBe(true);
    expect(readBack.interrupted).toBe(false);
  });

  it('removes an event row when its session row is deleted', async () => {
    orm = await openLegacyDatabase();
    const em = orm.em.fork();
    const storageSession = em.create(StorageSession, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
      state: {},
      createTime: new Date(1000),
      updateTime: new Date(1000),
    });
    em.create(
      StorageEventV0,
      storageEventV0FromEvent(
        storageSession,
        createEvent({id: 'event_id', author: 'agent', timestamp: 1000}),
      ),
    );
    await em.flush();

    await orm.em.fork().nativeDelete(StorageSession, {id: SESSION_ID});

    const remaining = await orm.em.fork().count(StorageEventV0, {});
    expect(remaining).toBe(0);
  });
});
