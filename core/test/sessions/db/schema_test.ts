/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The index cases are ported from
 * `tests/unittests/sessions/migration/test_database_schema.py` in
 * google/adk-python. Each one names the Python test it comes from.
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
  EVENTS_SESSION_TIMESTAMP_INDEX,
  StorageEvent,
  StorageSession,
} from '../../../src/sessions/db/schema.js';

const APP_NAME = 'my_app';
const USER_ID = 'test_user';
const SESSION_ID = 's1';
const INVOCATION_ID = 'invocation-1';
const INDEX_COLUMNS = ['app_name', 'user_id', 'session_id', 'timestamp'];
/** The literal name adk-python declares, so a rename here fails the tests. */
const INDEX_NAME = 'idx_events_app_user_session_ts';

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

/** Opens a sqlite database the way `DatabaseSessionService.init()` does. */
async function openDatabase(databaseFile: string): Promise<MikroORM> {
  const orm = await MikroORM.init(
    await getConnectionOptionsFromUri(`sqlite://${databaseFile}`),
  );
  await ensureDatabaseCreated(orm);
  await validateDatabaseSchemaVersion(orm);
  return orm;
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

function seedSession(orm: MikroORM, sessionId = SESSION_ID) {
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

function seedEvent(orm: MikroORM, eventId: string, sessionId = SESSION_ID) {
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
  });
  return em.flush();
}

describe('sessions storage schema', () => {
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

  describe('generated DDL', () => {
    it('gives events a cascading foreign key and the lookup index on sqlite', async () => {
      const orm = await track(
        await MikroORM.init({
          dbName: ':memory:',
          driver: SqliteDriver,
          entities: ENTITIES,
        }),
      );

      const sql = await orm.schema.getCreateSchemaSQL();

      expect(sql).toContain(
        'foreign key(`session_id`, `app_name`, `user_id`) references `sessions`(`id`, `app_name`, `user_id`) on delete cascade',
      );
      expect(sql).toContain(
        'create index `idx_events_app_user_session_ts` on `events` (`app_name`, `user_id`, `session_id`, `timestamp`)',
      );
    });

    /**
     * InnoDB rejects a foreign key whose referenced columns do not lead an
     * index of the parent table, and the primary key is the only index
     * `sessions` has. MySQL 8.0.45 fails the `alter table` with errno 1822
     * when the two lists disagree, which no DDL string assertion can see.
     */
    it('references the sessions columns in primary key order', async () => {
      const orm = await track(
        await MikroORM.init({
          dbName: ':memory:',
          driver: SqliteDriver,
          entities: ENTITIES,
        }),
      );
      const metadata = orm.getMetadata();

      const referenced = metadata.get(StorageEvent.name).properties['session']
        .referencedColumnNames;
      const sessionKey = metadata
        .get(StorageSession.name)
        .getPrimaryProps()
        .flatMap((property) => property.fieldNames);

      expect(referenced).toEqual(sessionKey);
    });

    it('keeps sub-second precision on every timestamp column on MySQL', async () => {
      const orm = await track(
        await MikroORM.init({
          dbName: 'adk',
          driver: MySqlDriver,
          entities: ENTITIES,
          connect: false,
        }),
      );

      const sql = await orm.schema.getCreateSchemaSQL();

      expect(sql).not.toContain('datetime not null');
      expect(sql.match(/datetime\(3\) not null/g)).toHaveLength(5);
      expect(sql).toContain(
        'foreign key (`session_id`, `app_name`, `user_id`) references `sessions` (`id`, `app_name`, `user_id`) on update no action on delete cascade',
      );
      expect(sql).toContain(
        'add index `idx_events_app_user_session_ts`(`app_name`, `user_id`, `session_id`, `timestamp`)',
      );
    });
  });

  describe('foreign key enforcement on sqlite', () => {
    it('deletes the events of a session that is deleted directly', async () => {
      const databaseFile = await tempDatabaseFile('cascade.db');
      const orm = await track(await openDatabase(databaseFile));
      await seedSession(orm);
      await seedEvent(orm, 'e1');
      await seedEvent(orm, 'e2');

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

      await expect(seedEvent(orm, 'e1', 'no-such-session')).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(await orm.em.fork().count(StorageEvent, {})).toBe(0);
    });
  });

  describe('index creation', () => {
    it('names the index the way adk-python names it', () => {
      expect(EVENTS_SESSION_TIMESTAMP_INDEX).toBe(INDEX_NAME);
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
      await seedSession(first);
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
      await seedSession(legacy);
      await seedEvent(legacy, 'e1');
      await legacy.close();

      const orm = await track(await openDatabase(databaseFile));

      expect(await orm.em.fork().count(StorageEvent, {})).toBe(1);
      expect(await indexColumns(orm, INDEX_NAME)).toEqual(INDEX_COLUMNS);
    });
  });
});
