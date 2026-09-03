/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEventActions} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ENTITIES_V0,
  StorageEventV0,
  storageEventV0ToEvent,
} from '../../../src/sessions/db/schema_v0.js';

/** Builds a v0 row with every column the converter reads populated. */
function fullRow(): StorageEventV0 {
  const row = new StorageEventV0();
  row.id = 'event-1';
  row.appName = 'app';
  row.userId = 'user';
  row.sessionId = 'session';
  row.invocationId = 'invocation-1';
  row.author = 'agent';
  row.branch = 'root.child';
  row.timestamp = new Date(1700000000123);
  row.longRunningToolIdsJson = JSON.stringify(['tool-a', 'tool-b']);
  row.content = {role: 'user', parts: [{text: 'hello'}]};
  row.groundingMetadata = {webSearchQueries: ['adk']};
  row.customMetadata = {tenant: 'acme'};
  row.usageMetadata = {totalTokenCount: 42};
  row.citationMetadata = {citations: [{uri: 'https://example.test/a'}]};
  row.inputTranscription = {text: 'spoken in'};
  row.outputTranscription = {text: 'spoken out'};
  row.partial = false;
  row.turnComplete = true;
  row.interrupted = false;
  row.errorCode = 'MALFORMED_FUNCTION_CALL';
  row.errorMessage = 'the model produced an unparseable call';
  return row;
}

describe('storageEventV0ToEvent', () => {
  it('copies every flat column onto the event', () => {
    const event = storageEventV0ToEvent(fullRow());

    expect(event.id).toBe('event-1');
    expect(event.invocationId).toBe('invocation-1');
    expect(event.author).toBe('agent');
    expect(event.branch).toBe('root.child');
    expect(event.timestamp).toBe(1700000000123);
    expect(event.content).toEqual({role: 'user', parts: [{text: 'hello'}]});
    expect(event.groundingMetadata).toEqual({webSearchQueries: ['adk']});
    expect(event.customMetadata).toEqual({tenant: 'acme'});
    expect(event.usageMetadata).toEqual({totalTokenCount: 42});
    expect(event.citationMetadata).toEqual({
      citations: [{uri: 'https://example.test/a'}],
    });
    expect(event.inputTranscription).toEqual({text: 'spoken in'});
    expect(event.outputTranscription).toEqual({text: 'spoken out'});
    expect(event.partial).toBe(false);
    expect(event.turnComplete).toBe(true);
    expect(event.interrupted).toBe(false);
    expect(event.errorCode).toBe('MALFORMED_FUNCTION_CALL');
    expect(event.errorMessage).toBe('the model produced an unparseable call');
  });

  it('returns empty actions, because the column holds a Python pickle', () => {
    const row = fullRow();
    row.actions = Buffer.from('\x80\x04pickled', 'binary');

    const event = storageEventV0ToEvent(row);

    expect(event.actions).toEqual(createEventActions());
  });

  it('parses the long-running tool ids out of their JSON column', () => {
    expect(storageEventV0ToEvent(fullRow()).longRunningToolIds).toEqual([
      'tool-a',
      'tool-b',
    ]);
  });

  it('yields no long-running tool ids when the column is null', () => {
    const row = fullRow();
    row.longRunningToolIdsJson = undefined;

    expect(storageEventV0ToEvent(row).longRunningToolIds).toEqual([]);
  });

  it('yields no long-running tool ids when the column holds no array', () => {
    const row = fullRow();
    row.longRunningToolIdsJson = '{"not": "an array"}';

    expect(storageEventV0ToEvent(row).longRunningToolIds).toEqual([]);
  });

  it('leaves every nullable column undefined when it is not set', () => {
    const row = new StorageEventV0();
    row.id = 'bare';
    row.appName = 'app';
    row.userId = 'user';
    row.sessionId = 'session';
    row.invocationId = 'invocation-1';
    row.author = 'agent';
    row.timestamp = new Date(1000);

    const event = storageEventV0ToEvent(row);

    expect(event.branch).toBeUndefined();
    expect(event.content).toBeUndefined();
    expect(event.groundingMetadata).toBeUndefined();
    expect(event.customMetadata).toBeUndefined();
    expect(event.usageMetadata).toBeUndefined();
    expect(event.citationMetadata).toBeUndefined();
    expect(event.inputTranscription).toBeUndefined();
    expect(event.outputTranscription).toBeUndefined();
    expect(event.partial).toBeUndefined();
    expect(event.turnComplete).toBeUndefined();
    expect(event.interrupted).toBeUndefined();
    expect(event.errorCode).toBeUndefined();
    expect(event.errorMessage).toBeUndefined();
    expect(event.longRunningToolIds).toEqual([]);
  });
});

describe('ENTITIES_V0', () => {
  let orm: MikroORM;

  afterEach(async () => {
    await orm.close();
  });

  it('maps the v0 event columns adk-python writes', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
      pool: {min: 1, max: 1},
    });
    await orm.schema.updateSchema({safe: true});

    const columns: Array<{name: string}> = await orm.em
      .getConnection()
      .execute('pragma table_info(events)', [], 'all');

    expect(columns.map((column) => column.name).sort()).toEqual(
      [
        'actions',
        'app_name',
        'author',
        'branch',
        'citation_metadata',
        'content',
        'custom_metadata',
        'error_code',
        'error_message',
        'grounding_metadata',
        'id',
        'input_transcription',
        'interrupted',
        'invocation_id',
        'long_running_tool_ids_json',
        'output_transcription',
        'partial',
        'session_id',
        'timestamp',
        'turn_complete',
        'usage_metadata',
        'user_id',
      ].sort(),
    );
  });

  it('registers no metadata table, which a v0 database does not have', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
      pool: {min: 1, max: 1},
    });
    await orm.schema.updateSchema({safe: true});

    const tables: Array<{name: string}> = await orm.em
      .getConnection()
      .execute(
        "select name from sqlite_master where type = 'table'",
        [],
        'all',
      );

    expect(tables.map((table) => table.name).sort()).toEqual([
      'app_states',
      'events',
      'sessions',
      'user_states',
    ]);
  });
});
