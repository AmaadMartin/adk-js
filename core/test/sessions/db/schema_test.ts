/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `test_*` cases below keep the names of the adk-python tests they port:
 * `tests/unittests/sessions/test_storage_session.py`,
 * `tests/unittests/sessions/migration/test_database_schema.py`, and
 * `test_get_session_keeps_exact_epoch_across_a_repeated_local_hour` in
 * `tests/unittests/sessions/test_session_service.py`.
 */

import {createEvent} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {MySqlDriver} from '@mikro-orm/mysql';
import {SqliteDriver} from '@mikro-orm/sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/operations.js';
import {
  ENTITIES,
  EVENTS_TIMESTAMP_INDEX_NAME,
  StorageEvent,
  storageEventFromEvent,
  storageEventToEvent,
  StorageSession,
  toSession,
} from '../../../src/sessions/db/schema.js';

const APP_NAME = 'my_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';
const INVOCATION_ID = 'inv1';

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

const INDEX_COLUMNS = ['app_name', 'user_id', 'session_id', 'timestamp'];
/** The literal name adk-python declares, so a rename here fails the tests. */
const INDEX_NAME = 'idx_events_app_user_session_ts';

/** The `create index` statement the entity's `expression` index emits. */
const INDEX_STATEMENT =
  `create index ${INDEX_NAME} on events ` +
  `(app_name, user_id, session_id, timestamp desc)`;

/**
 * The schema adk-js emitted before this change: no foreign key on `events`
 * and no `idx_events_app_user_session_ts`.
 */
const PRE_CHANGE_DDL = [
  'create table `adk_internal_metadata` (`key` text not null, `value` text not null, primary key (`key`))',
  'create table `app_states` (`app_name` text not null, `state` json not null, `update_time` datetime not null, primary key (`app_name`))',
  'create table `user_states` (`app_name` text not null, `user_id` text not null, `state` json not null, `update_time` datetime not null, primary key (`app_name`, `user_id`))',
  'create table `sessions` (`id` text not null, `app_name` text not null, `user_id` text not null, `state` json not null, `create_time` datetime not null, `update_time` datetime not null, primary key (`id`, `app_name`, `user_id`))',
  'create table `events` (`id` text not null, `app_name` text not null, `user_id` text not null, `session_id` text not null, `invocation_id` text not null, `timestamp` datetime not null, `event_data` json not null, primary key (`id`, `app_name`, `user_id`, `session_id`))',
];

function sessionRow(updateTime: Date): StorageSession {
  const row = new StorageSession();
  row.appName = APP_NAME;
  row.userId = USER_ID;
  row.id = SESSION_ID;
  row.state = {};
  row.updateTime = updateTime;
  return row;
}

function eventRow(id: string, timestamp: Date, payloadEpoch: number) {
  const row = new StorageEvent();
  row.id = id;
  row.appName = APP_NAME;
  row.userId = USER_ID;
  row.sessionId = SESSION_ID;
  row.invocationId = INVOCATION_ID;
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

/** Opens a sqlite database the way `DatabaseSessionService.init()` does. */
async function openDatabase(databaseFile: string): Promise<MikroORM> {
  const orm = await MikroORM.init(
    await getConnectionOptionsFromUri(`sqlite://${databaseFile}`),
  );
  await ensureDatabaseCreated(orm);
  await validateDatabaseSchemaVersion(orm);
  return orm;
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

/**
 * Runs a query and names the shape of its rows.
 *
 * `Connection.execute` is declared as returning `QueryResult<T> | any | any[]`,
 * so its own generic parameter cannot type the result.
 */
async function query<T>(
  orm: MikroORM,
  sql: string,
  params?: string[],
): Promise<T[]> {
  const rows: T[] = await orm.em.getConnection().execute(sql, params);
  return rows;
}

/** Columns of a sqlite index in index order, or `[]` when it is absent. */
async function indexColumns(orm: MikroORM, name: string): Promise<string[]> {
  const rows = await query<{name: string}>(
    orm,
    'select name from pragma_index_info(?) order by seqno',
    [name],
  );
  return rows.map((row) => row.name);
}

function seedSessionRow(orm: MikroORM, sessionId = SESSION_ID) {
  const em = orm.em.fork();
  em.create(StorageSession, {
    id: sessionId,
    appName: APP_NAME,
    userId: USER_ID,
    state: {},
    createTime: new Date(),
    updateTime: new Date(),
  });
  return em.flush();
}

function seedEventRow(orm: MikroORM, eventId: string, sessionId = SESSION_ID) {
  const timestamp = new Date('2026-01-02T03:04:05.123Z');
  const em = orm.em.fork();
  em.create(StorageEvent, {
    id: eventId,
    appName: APP_NAME,
    userId: USER_ID,
    sessionId,
    invocationId: INVOCATION_ID,
    timestamp,
    eventData: createEvent({
      id: eventId,
      author: 'user',
      invocationId: INVOCATION_ID,
      timestamp: timestamp.getTime(),
    }),
    storageSession: em.getReference(StorageSession, [
      sessionId,
      APP_NAME,
      USER_ID,
    ]),
  });
  return em.flush();
}

describe('schema converters', () => {
  it('test_to_session_without_arguments_yields_empty_state_and_events', () => {
    const session = toSession(sessionRow(NAIVE_UPDATE_TIME), {state: {}});

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

    const session = toSession(row, {state: {}});

    expect(session.lastUpdateTime).toBe(row.updateTime.getTime());
  });

  it('test_to_session_normalizes_aware_update_time_marker_to_utc', () => {
    // Only the instant half of the adk-python case ports. adk-js has no
    // revision marker to normalize, because nothing here reads one.
    const row = sessionRow(AWARE_UPDATE_TIME);

    const session = toSession(row, {state: {}});

    expect(session.lastUpdateTime).toBe(AWARE_UPDATE_TIME.getTime());
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

    expect(indexed.map((column) => column['name'])).toEqual(INDEX_COLUMNS);
    expect(indexed.map((column) => column['desc'])).toEqual([0, 0, 0, 1]);
  });

  it('declares the events foreign key with on delete cascade', async () => {
    orm = await openOrm();

    const sql = await orm.schema.getCreateSchemaSQL();
    const eventsTable = sql
      .split('\n')
      .find((line) => line.startsWith('create table `events`'));

    expect(eventsTable).toBeDefined();
    // The two column lists follow StorageSession's primary-key order, which is
    // `id, app_name, user_id`. See the relation's own comment.
    expect(eventsTable).toContain(
      'foreign key(`session_id`, `app_name`, `user_id`) ' +
        'references `sessions`(`id`, `app_name`, `user_id`) on delete cascade',
    );
    expect(eventsTable).toContain(
      'primary key (`id`, `app_name`, `user_id`, `session_id`)',
    );
  });

  it('gives events a cascading foreign key and the lookup index on sqlite', async () => {
    orm = await openOrm();

    const sql = await orm.schema.getCreateSchemaSQL();

    expect(sql).toContain(
      'foreign key(`session_id`, `app_name`, `user_id`) references ' +
        '`sessions`(`id`, `app_name`, `user_id`) on delete cascade',
    );
    expect(sql).toContain(INDEX_STATEMENT);
  });

  /**
   * InnoDB rejects a foreign key whose referenced columns do not lead an
   * index of the parent table, and the primary key is the only index
   * `sessions` has. MySQL 8.0.45 fails the `alter table` with errno 1822 when
   * the two lists disagree, which no DDL string assertion can see.
   */
  it('references the sessions columns in primary key order', async () => {
    orm = await openOrm();
    const metadata = orm.getMetadata();

    const referenced = metadata.get(StorageEvent.name).properties[
      'storageSession'
    ].referencedColumnNames;
    const sessionKey = metadata
      .get(StorageSession.name)
      .getPrimaryProps()
      .flatMap((property) => property.fieldNames);

    expect(referenced).toEqual(sessionKey);
  });

  it('keeps sub-second precision on every timestamp column on MySQL', async () => {
    orm = await MikroORM.init({
      dbName: 'adk',
      driver: MySqlDriver,
      entities: ENTITIES,
      connect: false,
    });

    const sql = await orm.schema.getCreateSchemaSQL();

    expect(sql).not.toContain('datetime not null');
    expect(sql.match(/datetime\(6\) not null/g)).toHaveLength(5);
    expect(sql).toContain(
      'foreign key (`session_id`, `app_name`, `user_id`) references ' +
        '`sessions` (`id`, `app_name`, `user_id`) on update cascade ' +
        'on delete cascade',
    );
    expect(sql).toContain(INDEX_STATEMENT);
  });
});

describe('foreign key enforcement on sqlite', () => {
  const openOrms: MikroORM[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const orm of openOrms.splice(0)) {
      await orm.close();
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  async function track(orm: MikroORM): Promise<MikroORM> {
    openOrms.push(orm);
    return orm;
  }

  async function tempDatabaseFile(name: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-schema-'));
    tempDirs.push(dir);
    return path.join(dir, name);
  }

  it('deletes the events of a session that is deleted directly', async () => {
    const databaseFile = await tempDatabaseFile('cascade.db');
    const orm = await track(await openDatabase(databaseFile));
    await seedSessionRow(orm);
    await seedEventRow(orm, 'e1');
    await seedEventRow(orm, 'e2');

    const pragma = await query<{foreign_keys: number}>(
      orm,
      'pragma foreign_keys',
    );
    expect(pragma[0].foreign_keys).toBe(1);

    const em = orm.em.fork();
    await em.nativeDelete(StorageSession, {
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(await em.count(StorageEvent, {})).toBe(0);
  });

  it('rejects an event whose session does not exist', async () => {
    const databaseFile = await tempDatabaseFile('orphan.db');
    const orm = await track(await openDatabase(databaseFile));

    await expect(seedEventRow(orm, 'e1', 'no-such-session')).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(await orm.em.fork().count(StorageEvent, {})).toBe(0);
  });

  describe('index creation', () => {
    it('names the index the way adk-python names it', () => {
      expect(EVENTS_TIMESTAMP_INDEX_NAME).toBe(INDEX_NAME);
    });

    // test_new_db_uses_latest_schema
    it('creates the events index on a new database', async () => {
      const databaseFile = await tempDatabaseFile('new_db.db');
      const orm = await track(await openDatabase(databaseFile));

      expect(await indexColumns(orm, INDEX_NAME)).toEqual(INDEX_COLUMNS);
    });

    // test_prepare_tables_recreates_missing_latest_events_index
    it('recreates the events index that a database has lost', async () => {
      const databaseFile = await tempDatabaseFile('missing_index.db');
      const first = await openDatabase(databaseFile);
      await seedSessionRow(first);
      await first.em.getConnection().execute(`drop index ${INDEX_NAME}`);
      expect(await indexColumns(first, INDEX_NAME)).toEqual([]);
      await first.close();

      const reopened = await track(await openDatabase(databaseFile));

      expect(
        await reopened.em.fork().findOne(StorageSession, {id: SESSION_ID}),
      ).not.toBeNull();
      expect(await indexColumns(reopened, INDEX_NAME)).toEqual(INDEX_COLUMNS);
    });

    it('adds the index to a database written before this change, keeping its rows', async () => {
      const databaseFile = await tempDatabaseFile('pre_change.db');
      const legacy = await MikroORM.init(
        await getConnectionOptionsFromUri(`sqlite://${databaseFile}`),
      );
      for (const statement of PRE_CHANGE_DDL) {
        await legacy.em.getConnection().execute(statement);
      }
      await seedSessionRow(legacy);
      await seedEventRow(legacy, 'e1');
      await legacy.close();

      const orm = await track(await openDatabase(databaseFile));

      expect(await orm.em.fork().count(StorageEvent, {})).toBe(1);
      expect(await indexColumns(orm, INDEX_NAME)).toEqual(INDEX_COLUMNS);
    });
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

  it('updates an event row that already exists', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    await seedSession(new Date(FIRST_REPEATED_HOUR_EPOCH));

    const em = orm.em.fork();
    const row = await em.findOneOrFail(StorageEvent, {id: 'e1'});
    row.timestamp = new Date(SECOND_REPEATED_HOUR_EPOCH);
    row.invocationId = 'inv2';
    await em.flush();

    const reloaded = await orm.em
      .fork()
      .findOneOrFail(StorageEvent, {id: 'e1'});
    expect(reloaded.timestamp.getTime()).toBe(SECOND_REPEATED_HOUR_EPOCH);
    expect(reloaded.invocationId).toBe('inv2');
  });

  it('removes an event row through the entity manager', async () => {
    orm = await openOrm();
    await orm.schema.createSchema();
    await seedSession(new Date(FIRST_REPEATED_HOUR_EPOCH));

    const em = orm.em.fork();
    em.remove(await em.findOneOrFail(StorageEvent, {id: 'e1'}));
    await em.flush();

    const remaining = await orm.em.fork().find(StorageEvent, {});
    expect(remaining.map((row) => row.id)).toEqual(['e2']);
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
});

/**
 * adk-python writes rows adk-js never produces: an event with no payload at
 * all, and a payload that carries no timestamp of its own. Both are read back
 * through the entity here.
 */
describe('rows written by adk-python', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.close();
    }
  });

  async function insertEvent(
    timestampColumn: number,
    eventData: string | null,
  ): Promise<StorageEvent> {
    await orm.schema.createSchema();
    const em = orm.em.fork();
    em.create(StorageSession, {
      id: 's1',
      appName: 'my_app',
      userId: 'u1',
      state: {},
      createTime: new Date(timestampColumn),
      updateTime: new Date(timestampColumn),
    });
    await em.flush();
    await orm.em
      .getConnection()
      .execute(
        "insert into events values ('e1', 'my_app', 'u1', 's1', 'inv1', " +
          `${timestampColumn}, ${eventData === null ? 'null' : `'${eventData}'`})`,
      );
    return orm.em.fork().findOneOrFail(StorageEvent, {id: 'e1'});
  }

  it('reads a row whose event_data is null', async () => {
    orm = await openOrm();
    const row = await insertEvent(FIRST_REPEATED_HOUR_EPOCH, null);

    const event = storageEventToEvent(row);

    expect(row.eventData).toBeNull();
    expect(event.id).toBe('e1');
    expect(event.invocationId).toBe('inv1');
    expect(event.timestamp).toBe(FIRST_REPEATED_HOUR_EPOCH);
    expect(event.actions.stateDelta).toEqual({});
  });

  it('falls back to the timestamp column when the payload has none', async () => {
    orm = await openOrm();
    const row = await insertEvent(
      SECOND_REPEATED_HOUR_EPOCH,
      '{"author": "user"}',
    );

    const event = storageEventToEvent(row);

    expect(event.author).toBe('user');
    expect(event.timestamp).toBe(SECOND_REPEATED_HOUR_EPOCH);
  });
});
