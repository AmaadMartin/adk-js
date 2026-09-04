/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createEvent} from '../../../src/events/event.js';
import {createEventActions} from '../../../src/events/event_actions.js';
import {StorageSession} from '../../../src/sessions/db/schema.js';
import {
  ENTITIES_V0,
  longRunningToolIdsOf,
  setLongRunningToolIds,
  StorageEventV0,
  storageEventV0FromEvent,
  storageEventV0ToEvent,
} from '../../../src/sessions/db/schema_v0.js';
import {createSession} from '../../../src/sessions/session.js';
import {logger} from '../../../src/utils/logger.js';
import {fromBase64} from '../../utils/pickle_payload_test_utils.js';
import {EVIL_EXEC, SIMPLE_STATE_DELTA} from '../pickled_actions_fixtures.js';

const SESSION = createSession({appName: 'app', userId: 'u1', id: 's1'});

const EMPTY_ACTIONS = {
  stateDelta: {},
  artifactDelta: {},
  requestedAuthConfigs: {},
  requestedToolConfirmations: {},
};

function legacyRow(overrides: Partial<StorageEventV0> = {}): StorageEventV0 {
  return Object.assign(new StorageEventV0(), {
    id: 'e1',
    appName: 'app',
    userId: 'u1',
    sessionId: 's1',
    invocationId: 'inv-1',
    author: 'user',
    timestamp: new Date(1_700_000_000_000),
    ...overrides,
  });
}

describe('storageEventV0ToEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps the scalar columns', () => {
    const event = storageEventV0ToEvent(
      legacyRow({
        branch: 'agent_1.agent_2',
        partial: true,
        turnComplete: false,
        errorCode: 'SAFETY',
        errorMessage: 'blocked',
        interrupted: true,
      }),
    );

    expect(event.id).toBe('e1');
    expect(event.invocationId).toBe('inv-1');
    expect(event.author).toBe('user');
    expect(event.branch).toBe('agent_1.agent_2');
    expect(event.timestamp).toBe(1_700_000_000_000);
    expect(event.partial).toBe(true);
    expect(event.turnComplete).toBe(false);
    expect(event.errorCode).toBe('SAFETY');
    expect(event.errorMessage).toBe('blocked');
    expect(event.interrupted).toBe(true);
  });

  it('maps every optional JSON column', () => {
    const event = storageEventV0ToEvent(
      legacyRow({
        content: {role: 'user', parts: [{text: 'hello'}]},
        groundingMetadata: {web_search_queries: ['adk']},
        customMetadata: {trace_id: 'abc'},
        usageMetadata: {total_token_count: 12},
        citationMetadata: {citations: [{title: 'a doc'}]},
        inputTranscription: {text: 'spoken in'},
        outputTranscription: {text: 'spoken out'},
      }),
    );

    expect(event.content).toEqual({role: 'user', parts: [{text: 'hello'}]});
    expect(event.groundingMetadata).toEqual({webSearchQueries: ['adk']});
    expect(event.customMetadata).toEqual({trace_id: 'abc'});
    expect(event.usageMetadata).toEqual({totalTokenCount: 12});
    expect(event.citationMetadata).toEqual({citations: [{title: 'a doc'}]});
    expect(event.inputTranscription).toEqual({text: 'spoken in'});
    expect(event.outputTranscription).toEqual({text: 'spoken out'});
  });

  it('parses the long running tool ids out of their JSON column', () => {
    const event = storageEventV0ToEvent(
      legacyRow({longRunningToolIdsJson: JSON.stringify(['tool-1', 'tool-2'])}),
    );

    expect(event.longRunningToolIds).toEqual(['tool-1', 'tool-2']);
  });

  it('leaves the long running tool ids unset when the column is empty', () => {
    expect(
      storageEventV0ToEvent(legacyRow()).longRunningToolIds,
    ).toBeUndefined();
  });

  it('yields empty actions rather than decoding the pickle', () => {
    const event = storageEventV0ToEvent(
      legacyRow({actions: Buffer.from('\x80\x04\x95pickled', 'binary')}),
    );

    expect(event.actions).toEqual({
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    });
  });

  it('decodes the actions a real adk-python row carries', () => {
    const event = storageEventV0ToEvent(
      legacyRow({actions: Buffer.from(fromBase64(SIMPLE_STATE_DELTA))}),
    );

    expect(event.actions.stateDelta).toEqual({skey: 4});
  });

  it('yields empty actions when the column is absent', () => {
    expect(storageEventV0ToEvent(legacyRow()).actions).toEqual(EMPTY_ACTIONS);
  });

  it('degrades to empty actions when the blob names a refused global', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const event = storageEventV0ToEvent(
      legacyRow({actions: Buffer.from(fromBase64(EVIL_EXEC))}),
    );

    expect(event.actions).toEqual(EMPTY_ACTIONS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('event e1');
    expect(warn.mock.calls[0][0]).toContain('builtins.exec');
  });

  it('degrades to empty actions when the blob is not a pickle at all', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const event = storageEventV0ToEvent(
      legacyRow({actions: Buffer.from('not a pickle', 'utf8')}),
    );

    expect(event.actions).toEqual(EMPTY_ACTIONS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('longRunningToolIdsOf', () => {
  it('drops a value that is not an array', () => {
    expect(
      longRunningToolIdsOf(legacyRow({longRunningToolIdsJson: '{"a": 1}'})),
    ).toBeUndefined();
  });

  it('keeps only the string members of the array', () => {
    expect(
      longRunningToolIdsOf(
        legacyRow({longRunningToolIdsJson: '["tool-1", 7, null]'}),
      ),
    ).toEqual(['tool-1']);
  });

  it('reads an empty array back as an empty array', () => {
    expect(
      longRunningToolIdsOf(legacyRow({longRunningToolIdsJson: '[]'})),
    ).toEqual([]);
  });
});

describe('setLongRunningToolIds', () => {
  it.each([
    ['a populated array', ['tool-1', 'tool-2'], '["tool-1","tool-2"]'],
    ['an empty array', [], '[]'],
  ])('writes %s as JSON', (_name, value, expected) => {
    const row = legacyRow();

    setLongRunningToolIds(row, value);

    expect(row.longRunningToolIdsJson).toBe(expected);
  });

  it('clears the column for undefined', () => {
    const row = legacyRow({longRunningToolIdsJson: '["tool-1"]'});

    setLongRunningToolIds(row, undefined);

    expect(row.longRunningToolIdsJson).toBeUndefined();
  });
});

describe('storageEventV0FromEvent', () => {
  it('takes the key columns from the session, not the event', () => {
    const row = storageEventV0FromEvent(
      SESSION,
      createEvent({id: 'e1', invocationId: 'inv-1', author: 'agent'}),
    );

    expect(row.appName).toBe('app');
    expect(row.userId).toBe('u1');
    expect(row.sessionId).toBe('s1');
    expect(row.id).toBe('e1');
    expect(row.invocationId).toBe('inv-1');
    expect(row.author).toBe('agent');
  });

  it('stores an empty author when the event has none', () => {
    expect(storageEventV0FromEvent(SESSION, createEvent({})).author).toBe('');
  });

  it('writes every optional JSON column that the event sets', () => {
    const row = storageEventV0FromEvent(
      SESSION,
      createEvent({
        content: {role: 'user', parts: [{text: 'hello'}]},
        groundingMetadata: {webSearchQueries: ['adk']},
        customMetadata: {trace_id: 'abc'},
        usageMetadata: {totalTokenCount: 12},
        citationMetadata: {citations: [{title: 'a doc'}]},
        inputTranscription: {text: 'spoken in'},
        outputTranscription: {text: 'spoken out'},
      }),
    );

    expect(row.content).toEqual({role: 'user', parts: [{text: 'hello'}]});
    expect(row.groundingMetadata).toEqual({web_search_queries: ['adk']});
    expect(row.customMetadata).toEqual({trace_id: 'abc'});
    expect(row.usageMetadata).toEqual({total_token_count: 12});
    expect(row.citationMetadata).toEqual({citations: [{title: 'a doc'}]});
    expect(row.inputTranscription).toEqual({text: 'spoken in'});
    expect(row.outputTranscription).toEqual({text: 'spoken out'});
  });

  it('leaves every optional JSON column unset when the event sets none', () => {
    const row = storageEventV0FromEvent(SESSION, createEvent({}));

    expect(row.content).toBeUndefined();
    expect(row.groundingMetadata).toBeUndefined();
    expect(row.customMetadata).toBeUndefined();
    expect(row.usageMetadata).toBeUndefined();
    expect(row.citationMetadata).toBeUndefined();
    expect(row.inputTranscription).toBeUndefined();
    expect(row.outputTranscription).toBeUndefined();
  });

  it('writes the long running tool ids through the setter', () => {
    const row = storageEventV0FromEvent(
      SESSION,
      createEvent({longRunningToolIds: ['tool-1']}),
    );

    expect(row.longRunningToolIdsJson).toBe('["tool-1"]');
  });

  it('writes actions adk-js can read back', () => {
    const actions = createEventActions({
      stateDelta: {greeting: 'hello', count: 7},
      artifactDelta: {'report.pdf': 3},
      transferToAgent: 'agent_b',
      escalate: true,
      skipSummarization: false,
    });

    const row = storageEventV0FromEvent(SESSION, createEvent({actions}));

    expect(storageEventV0ToEvent(row).actions).toEqual(actions);
  });

  it('refuses to write actions holding a value with no Python counterpart', () => {
    const event = createEvent({
      actions: createEventActions({stateDelta: {when: new Date(0)}}),
    });

    expect(() => storageEventV0FromEvent(SESSION, event)).toThrowError(
      /Cannot write an instance of Date as a pickled value/,
    );
  });
});

describe('the v0 entity set', () => {
  let orm: MikroORM | undefined;

  afterEach(async () => {
    await orm?.close();
    orm = undefined;
  });

  it('holds the legacy event entity and no metadata entity', () => {
    expect(ENTITIES_V0).toContain(StorageEventV0);
    expect(ENTITIES_V0).toContain(StorageSession);
    expect(ENTITIES_V0.map((entity) => entity.name)).not.toContain(
      'StorageMetadata',
    );
  });

  it('declares the event index and the cascading foreign key', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
    });

    const sql = await orm.schema.getCreateSchemaSQL();

    expect(sql).toContain(
      'create index idx_events_app_user_session_ts on events ' +
        '(app_name, user_id, session_id, timestamp desc)',
    );
    expect(sql).toContain(
      'foreign key(`session_id`, `app_name`, `user_id`) references ' +
        '`sessions`(`id`, `app_name`, `user_id`) on delete cascade',
    );
    expect(sql).toContain(
      'primary key (`id`, `app_name`, `user_id`, `session_id`)',
    );
  });

  it('keeps sub-second precision on the timestamp column', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
    });

    const properties = orm.getMetadata().get(StorageEventV0.name)
      .properties as Record<string, {length?: number}>;

    expect(properties['timestamp'].length).toBe(3);
  });

  it('round-trips an event through a real database', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
    });
    await orm.schema.createSchema();
    const em = orm.em.fork();

    const storedSession = new StorageSession();
    storedSession.appName = 'app';
    storedSession.userId = 'u1';
    storedSession.id = 's1';
    storedSession.state = {};
    em.persist(storedSession);

    const event = createEvent({
      id: 'e1',
      invocationId: 'inv-1',
      author: 'agent',
      branch: 'root.child',
      timestamp: 1_700_000_000_123,
      content: {role: 'model', parts: [{text: 'hi'}]},
      longRunningToolIds: ['tool-1'],
      errorCode: 'SAFETY',
      errorMessage: 'blocked',
      actions: createEventActions({
        stateDelta: {greeting: 'hello'},
        escalate: true,
      }),
    });
    em.persist(storageEventV0FromEvent(SESSION, event));
    await em.flush();

    const read = await orm.em.fork().findOneOrFail(StorageEventV0, {id: 'e1'});
    const readBack = storageEventV0ToEvent(read);

    expect(readBack.id).toBe('e1');
    expect(readBack.invocationId).toBe('inv-1');
    expect(readBack.author).toBe('agent');
    expect(readBack.branch).toBe('root.child');
    expect(readBack.timestamp).toBe(1_700_000_000_123);
    expect(readBack.content).toEqual({role: 'model', parts: [{text: 'hi'}]});
    expect(readBack.longRunningToolIds).toEqual(['tool-1']);
    expect(readBack.errorCode).toBe('SAFETY');
    expect(readBack.errorMessage).toBe('blocked');
    expect(readBack.actions).toEqual(event.actions);
  });

  it('deletes an event when its session goes', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES_V0,
    });
    await orm.schema.createSchema();
    const connection = orm.em.getConnection();
    await connection.execute('pragma foreign_keys = on');
    const em = orm.em.fork();

    const storedSession = new StorageSession();
    storedSession.appName = 'app';
    storedSession.userId = 'u1';
    storedSession.id = 's1';
    storedSession.state = {};
    em.persist(storedSession);
    em.persist(storageEventV0FromEvent(SESSION, createEvent({id: 'e1'})));
    await em.flush();

    await connection.execute(
      "delete from sessions where id = 's1' and app_name = 'app' " +
        "and user_id = 'u1'",
    );

    expect(await em.count(StorageEventV0, {})).toBe(0);
  });
});
