/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `test_*` cases below keep the names of the adk-python tests they port:
 * `tests/unittests/sessions/test_storage_session.py`, the index half of
 * `tests/unittests/sessions/migration/test_database_schema.py`, and
 * `test_get_session_keeps_exact_epoch_across_a_repeated_local_hour` in
 * `tests/unittests/sessions/test_session_service.py`.
 */

import {createEvent} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ENTITIES,
  EVENTS_TIMESTAMP_INDEX_NAME,
  getUpdateMarker,
  getUpdateTimestamp,
  StorageEvent,
  storageEventFromEvent,
  storageEventToEvent,
  StorageSession,
  toSession,
} from '../../../src/sessions/db/schema.js';

/** A naive stored timestamp, as sqlite and PostgreSQL hand it back. */
const NAIVE_UPDATE_TIME = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 123));

/** The same wall-clock reading, in a zone five hours ahead of UTC. */
const AWARE_UPDATE_TIME = new Date('2026-01-02T03:04:05.123+05:00');

/**
 * The hour a US daylight-saving fall-back repeats: 01:30 local happens twice,
 * so the two instants an hour apart share one local reading.
 */
const FIRST_REPEATED_HOUR_EPOCH = 1730613600000;
const SECOND_REPEATED_HOUR_EPOCH = 1730615400000;

function sessionRow(updateTime: Date): StorageSession {
  const row = new StorageSession();
  row.appName = 'my_app';
  row.userId = 'u1';
  row.id = 's1';
  row.state = {};
  row.updateTime = updateTime;
  return row;
}

function eventRow(id: string, timestamp: Date, payloadEpoch: number) {
  const row = new StorageEvent();
  row.id = id;
  row.appName = 'my_app';
  row.userId = 'u1';
  row.sessionId = 's1';
  row.invocationId = 'inv1';
  row.timestamp = timestamp;
  row.eventData = createEvent({id, timestamp: payloadEpoch});
  return row;
}

async function openOrm(): Promise<MikroORM> {
  return MikroORM.init({
    dbName: ':memory:',
    driver: SqliteDriver,
    entities: ENTITIES,
    allowGlobalContext: true,
  });
}

/** Runs a statement whose rows the sqlite driver hands back untyped. */
async function readRows(
  orm: MikroORM,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: unknown = await orm.em.getConnection().execute(sql);
  if (!Array.isArray(rows)) {
    return expect.fail(`${sql} returned no rows`);
  }
  return rows;
}

describe('schema converters', () => {
  it('test_to_session_without_arguments_yields_empty_state_and_events', () => {
    const session = toSession(sessionRow(NAIVE_UPDATE_TIME));

    expect(session.appName).toBe('my_app');
    expect(session.userId).toBe('u1');
    expect(session.id).toBe('s1');
    expect(session.state).toEqual({});
    expect(session.events).toEqual([]);
  });

  it('test_to_session_carries_supplied_state_and_events', () => {
    const event = createEvent({invocationId: 'inv1', author: 'user'});

    const session = toSession(sessionRow(NAIVE_UPDATE_TIME), {
      state: {k: 'v'},
      events: [event],
    });

    expect(session.state).toEqual({k: 'v'});
    expect(session.events.map((e) => e.invocationId)).toEqual(['inv1']);
  });

  it('test_to_session_reads_naive_update_time_as_utc', () => {
    // adk-python pins a non-UTC zone here, because a naive Python datetime
    // reads differently depending on the zone it is interpreted in. A JS Date
    // is an absolute instant with no naive form, so there is nothing to pin.
    const row = sessionRow(NAIVE_UPDATE_TIME);

    const session = toSession(row);

    expect(session.lastUpdateTime).toBe(row.updateTime.getTime());
    expect(session.storageUpdateMarker).toBe('2026-01-02T03:04:05.123Z');
  });

  it('test_to_session_normalizes_aware_update_time_marker_to_utc', () => {
    const row = sessionRow(AWARE_UPDATE_TIME);

    const session = toSession(row);

    expect(session.lastUpdateTime).toBe(AWARE_UPDATE_TIME.getTime());
    expect(session.storageUpdateMarker).toBe('2026-01-01T22:04:05.123Z');
  });

  it('gives two rows one millisecond apart different markers', () => {
    const earlier = sessionRow(new Date(1730613600000));
    const later = sessionRow(new Date(1730613600001));

    expect(getUpdateMarker(earlier)).not.toBe(getUpdateMarker(later));
    expect(getUpdateTimestamp(later) - getUpdateTimestamp(earlier)).toBe(1);
  });

  it('test_get_session_keeps_exact_epoch_across_a_repeated_local_hour', () => {
    // Both rows carry the same local wall-clock reading in their `timestamp`
    // column; only the stored payload tells the two instants apart.
    const sharedLocalReading = new Date(FIRST_REPEATED_HOUR_EPOCH);
    const first = eventRow('e1', sharedLocalReading, FIRST_REPEATED_HOUR_EPOCH);
    const second = eventRow(
      'e2',
      sharedLocalReading,
      SECOND_REPEATED_HOUR_EPOCH,
    );

    expect(storageEventToEvent(first).timestamp).toBe(
      FIRST_REPEATED_HOUR_EPOCH,
    );
    expect(storageEventToEvent(second).timestamp).toBe(
      SECOND_REPEATED_HOUR_EPOCH,
    );
  });

  it('populates every event column and the session relation', () => {
    const storageSession = sessionRow(NAIVE_UPDATE_TIME);
    const event = createEvent({
      id: 'e1',
      invocationId: 'inv1',
      timestamp: FIRST_REPEATED_HOUR_EPOCH,
    });

    const row = storageEventFromEvent(storageSession, event);

    expect(row).toEqual({
      id: 'e1',
      appName: 'my_app',
      userId: 'u1',
      sessionId: 's1',
      invocationId: 'inv1',
      timestamp: new Date(FIRST_REPEATED_HOUR_EPOCH),
      eventData: event,
      storageSession,
    });
  });
});

describe('schema DDL', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.close();
    }
  });

  it('test_new_db_uses_latest_schema', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();

    const columns = await readRows(
      orm,
      `pragma index_xinfo('${EVENTS_TIMESTAMP_INDEX_NAME}')`,
    );
    const indexed = columns.filter((column) => column['key'] === 1);

    expect(indexed.map((column) => column['name'])).toEqual([
      'app_name',
      'user_id',
      'session_id',
      'timestamp',
    ]);
    expect(indexed.map((column) => column['desc'])).toEqual([0, 0, 0, 1]);
  });

  it('declares the events foreign key with on delete cascade', async () => {
    orm = await openOrm();

    const sql = await orm.schema.getCreateSchemaSQL();
    const eventsTable = sql
      .split('\n')
      .find((line) => line.startsWith('create table `events`'));

    expect(eventsTable).toBeDefined();
    expect(eventsTable).toContain(
      'foreign key(`app_name`, `user_id`, `session_id`) ' +
        'references `sessions`(`app_name`, `user_id`, `id`) on delete cascade',
    );
    expect(eventsTable).toContain(
      'primary key (`id`, `app_name`, `user_id`, `session_id`)',
    );
  });
});

describe('schema behaviour on sqlite', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.close();
    }
  });

  async function seedSession(updateTime: Date): Promise<void> {
    const em = orm.em.fork();
    const session = em.create(StorageSession, {
      id: 's1',
      appName: 'my_app',
      userId: 'u1',
      state: {},
      createTime: updateTime,
      updateTime,
    });
    em.create(
      StorageEvent,
      storageEventFromEvent(
        session,
        createEvent({id: 'e1', timestamp: FIRST_REPEATED_HOUR_EPOCH}),
      ),
    );
    em.create(
      StorageEvent,
      storageEventFromEvent(
        session,
        createEvent({id: 'e2', timestamp: SECOND_REPEATED_HOUR_EPOCH}),
      ),
    );
    await em.flush();
  }

  it('round trips an event through both converters', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    await seedSession(new Date(FIRST_REPEATED_HOUR_EPOCH));

    const row = await orm.em.fork().findOneOrFail(StorageEvent, {id: 'e1'});
    const event = storageEventToEvent(row);

    expect(event.id).toBe('e1');
    expect(event.invocationId).toBe('');
    expect(event.timestamp).toBe(FIRST_REPEATED_HOUR_EPOCH);
    expect(row.storageSession.id).toBe('s1');
  });

  it('deletes a session row and its events together', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    await seedSession(new Date(FIRST_REPEATED_HOUR_EPOCH));

    const em = orm.em.fork();
    await em.nativeDelete(StorageSession, {
      id: 's1',
      appName: 'my_app',
      userId: 'u1',
    });

    expect(await em.count(StorageEvent, {sessionId: 's1'})).toBe(0);
  });

  it('advances update_time when only the state changes', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    const seeded = new Date(FIRST_REPEATED_HOUR_EPOCH);
    await seedSession(seeded);

    const em = orm.em.fork();
    const row = await em.findOneOrFail(StorageSession, {id: 's1'});
    row.state = {changed: true};
    await em.flush();

    const reloaded = await orm.em
      .fork()
      .findOneOrFail(StorageSession, {id: 's1'});
    expect(reloaded.updateTime.getTime()).toBeGreaterThan(seeded.getTime());
  });

  it('keeps an explicitly assigned update_time', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    await seedSession(new Date(FIRST_REPEATED_HOUR_EPOCH));

    const em = orm.em.fork();
    const row = await em.findOneOrFail(StorageSession, {id: 's1'});
    row.state = {changed: true};
    row.updateTime = new Date(SECOND_REPEATED_HOUR_EPOCH);
    await em.flush();

    const reloaded = await orm.em
      .fork()
      .findOneOrFail(StorageSession, {id: 's1'});
    expect(reloaded.updateTime.getTime()).toBe(SECOND_REPEATED_HOUR_EPOCH);
  });
});

/**
 * adk-python declares `events.event_data` nullable and writes no timestamp into
 * the payload of an event that has none, so a database it produced holds rows
 * adk-js's own DDL would reject. These build that table by hand and read it
 * back through the entity.
 */
describe('rows written by adk-python', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.close();
    }
  });

  async function createLegacyTables(): Promise<void> {
    const connection = orm.em.getConnection();
    await connection.execute(
      'create table sessions (id text not null, app_name text not null, ' +
        'user_id text not null, state json not null, ' +
        'create_time datetime not null, update_time datetime not null, ' +
        'primary key (app_name, user_id, id))',
    );
    await connection.execute(
      'create table events (id text not null, app_name text not null, ' +
        'user_id text not null, session_id text not null, ' +
        'invocation_id text not null, timestamp datetime not null, ' +
        'event_data json null, ' +
        'primary key (id, app_name, user_id, session_id))',
    );
  }

  it('reads a row whose event_data is null', async () => {
    orm = await openOrm();
    await createLegacyTables();
    await orm.em
      .getConnection()
      .execute(
        "insert into events values ('e1', 'my_app', 'u1', 's1', 'inv1', " +
          `${FIRST_REPEATED_HOUR_EPOCH}, null)`,
      );

    const row = await orm.em.fork().findOneOrFail(StorageEvent, {id: 'e1'});
    const event = storageEventToEvent(row);

    expect(row.eventData).toBeNull();
    expect(event.id).toBe('e1');
    expect(event.invocationId).toBe('inv1');
    expect(event.timestamp).toBe(FIRST_REPEATED_HOUR_EPOCH);
    expect(event.actions.stateDelta).toEqual({});
  });

  it('falls back to the timestamp column when the payload has none', async () => {
    orm = await openOrm();
    await createLegacyTables();
    await orm.em
      .getConnection()
      .execute(
        "insert into events values ('e1', 'my_app', 'u1', 's1', 'inv1', " +
          `${SECOND_REPEATED_HOUR_EPOCH}, '{"author": "user"}')`,
      );

    const row = await orm.em.fork().findOneOrFail(StorageEvent, {id: 'e1'});
    const event = storageEventToEvent(row);

    expect(event.author).toBe('user');
    expect(event.timestamp).toBe(SECOND_REPEATED_HOUR_EPOCH);
  });
});
