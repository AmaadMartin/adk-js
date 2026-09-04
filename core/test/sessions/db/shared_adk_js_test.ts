/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of the session storage column types that
 * `tests/unittests/sessions/test_schemas_shared.py` in google/adk-python does
 * not cover: the MariaDB branch, the tagged JSON parse error, and the schema
 * each backend generates.
 */

import {EntityProperty, MikroORM, Options} from '@mikro-orm/core';
import {MariaDbDriver, MariaDbPlatform} from '@mikro-orm/mariadb';
import {MsSqlDriver} from '@mikro-orm/mssql';
import {MySqlDriver} from '@mikro-orm/mysql';
import {PostgreSqlDriver} from '@mikro-orm/postgresql';
import {SqliteDriver, SqlitePlatform} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {ENTITIES, StorageSession} from '../../../src/sessions/db/schema.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  DynamicJsonType,
  PreciseTimestampType,
} from '../../../src/sessions/db/shared.js';

/** The driver each backend uses, and the session columns it must declare. */
const BACKENDS = {
  sqlite: {
    driver: SqliteDriver,
    columns: [
      '`state` json',
      '`create_time` datetime',
      '`update_time` datetime',
    ],
  },
  mysql: {
    driver: MySqlDriver,
    columns: [
      '`state` longtext',
      '`create_time` datetime(6)',
      '`update_time` datetime(6)',
    ],
  },
  mariadb: {
    driver: MariaDbDriver,
    columns: [
      '`state` longtext',
      '`create_time` datetime(6)',
      '`update_time` datetime(6)',
    ],
  },
  postgresql: {
    driver: PostgreSqlDriver,
    columns: [
      '"state" jsonb',
      '"create_time" timestamp(6)',
      '"update_time" timestamp(6)',
    ],
  },
  mssql: {
    driver: MsSqlDriver,
    columns: [
      '[state] nvarchar(max)',
      '[create_time] datetime2(6)',
      '[update_time] datetime2(6)',
    ],
  },
} satisfies Record<string, {driver: Options['driver']; columns: string[]}>;

/**
 * The SQLite schema these column types must leave alone.
 *
 * SQLite is the backend adk-js runs by default, so its DDL must not move: a
 * changed declaration makes `updateSchema` alter every existing database. Every
 * column declaration here is the one `main` generates. The `events` table also
 * carries the nullable `event_data`, the foreign key and the timestamp index
 * that the integration branch declares, and it follows `sessions` because the
 * foreign key orders the two.
 */
const SQLITE_SCHEMA_ON_MAIN = [
  'create table `app_states` (`app_name` text not null, `state` json not null, `update_time` datetime not null, primary key (`app_name`));',
  'create table `adk_internal_metadata` (`key` text not null, `value` text not null, primary key (`key`));',
  'create table `sessions` (`id` text not null, `app_name` text not null, `user_id` text not null, `state` json not null, `create_time` datetime not null, `update_time` datetime not null, primary key (`id`, `app_name`, `user_id`));',
  'create table `events` (`id` text not null, `app_name` text not null, `user_id` text not null, `session_id` text not null, `invocation_id` text not null, `timestamp` datetime not null, `event_data` json null, ' +
    'constraint `events_session_id_app_name_user_id_foreign` foreign key(`session_id`, `app_name`, `user_id`) references `sessions`(`id`, `app_name`, `user_id`) on delete cascade on update cascade, ' +
    'primary key (`id`, `app_name`, `user_id`, `session_id`));\n' +
    'create index idx_events_app_user_session_ts on events (app_name, user_id, session_id, timestamp desc);',
  'create table `user_states` (`app_name` text not null, `user_id` text not null, `state` json not null, `update_time` datetime not null, primary key (`app_name`, `user_id`));',
]
  .map((statement) => `${statement}\n\n`)
  .join('');

/** Builds the schema a backend would create, without connecting to it. */
async function createSchemaSql(driver: Options['driver']): Promise<string> {
  const orm = await MikroORM.init({
    dbName: 'schema_check',
    driver,
    entities: ENTITIES,
    connect: false,
    allowGlobalContext: true,
  });
  try {
    return await orm.schema.getCreateSchemaSQL();
  } finally {
    await orm.close();
  }
}

describe('session storage column types, beyond the reference suite', () => {
  let orm: MikroORM;
  let columnProp: EntityProperty;

  beforeAll(async () => {
    orm = await MikroORM.init({
      dbName: 'metadata_only',
      driver: SqliteDriver,
      entities: ENTITIES,
      connect: false,
      allowGlobalContext: true,
    });
    // `getColumnType` ignores the property, so one serves both types.
    columnProp = orm.getMetadata().get(StorageSession).properties.updateTime;
  });

  afterAll(async () => {
    await orm.close();
  });

  it('groups MariaDB with MySQL', () => {
    const mariadb = new MariaDbPlatform();

    expect(new DynamicJsonType().getColumnType(columnProp, mariadb)).toBe(
      'longtext',
    );
    expect(new PreciseTimestampType().getColumnType(columnProp, mariadb)).toBe(
      'datetime(6)',
    );
  });

  it('reads a numeric column as milliseconds, the MikroORM epoch unit', () => {
    expect(
      new PreciseTimestampType().convertToJSValue(1000, new SqlitePlatform()),
    ).toEqual(new Date(1000));
  });

  it('names session state as the source of malformed stored JSON', () => {
    let thrown: Error | undefined;

    try {
      new DynamicJsonType().convertToJSValue('{not json');
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }

    expect(thrown?.message).toMatch(/^Invalid JSON in session state: /);
    expect(thrown?.cause).toBeInstanceOf(SyntaxError);
  });

  for (const [backend, {driver, columns}] of Object.entries(BACKENDS)) {
    it(`declares the session columns ${backend} expects`, async () => {
      const sql = await createSchemaSql(driver);

      for (const column of columns) {
        expect(sql).toContain(column);
      }
    });
  }

  it('bounds the metadata value column', async () => {
    const sql = await createSchemaSql(BACKENDS.mysql.driver);

    expect(sql).toContain(`\`value\` varchar(${DEFAULT_MAX_VARCHAR_LENGTH})`);
  });

  it('bounds the event invocation id column', async () => {
    const sql = await createSchemaSql(BACKENDS.mysql.driver);

    expect(sql).toContain(
      `\`invocation_id\` varchar(${DEFAULT_MAX_VARCHAR_LENGTH})`,
    );
  });

  it('gives the event data column the dynamic declaration too', async () => {
    const sql = await createSchemaSql(BACKENDS.mysql.driver);

    expect(sql).toContain('`event_data` longtext');
  });

  it('leaves the SQLite schema exactly as it was', async () => {
    const sql = await createSchemaSql(BACKENDS.sqlite.driver);

    expect(sql).toBe(SQLITE_SCHEMA_ON_MAIN);
  });
});

describe('a session stored in SQLite', () => {
  const WRITTEN_AT = new Date('2026-01-02T03:04:05.123Z');
  const STATE = {greeting: 'héllo', nested: {deep: [1, 2, {flag: true}]}};

  let orm: MikroORM;

  beforeEach(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      allowGlobalContext: true,
    });
    await orm.schema.createSchema();

    const em = orm.em.fork();
    em.create(StorageSession, {
      id: 'session-id',
      appName: 'app',
      userId: 'user',
      state: STATE,
      createTime: WRITTEN_AT,
      updateTime: WRITTEN_AT,
    });
    await em.flush();
  });

  afterEach(async () => {
    await orm.close();
  });

  it('reads back its state and its milliseconds', async () => {
    const read = await orm.em
      .fork()
      .findOneOrFail(StorageSession, {id: 'session-id'});

    expect(read.state).toEqual(STATE);
    expect(read.createTime).toBeInstanceOf(Date);
    expect(read.createTime.getTime()).toBe(WRITTEN_AT.getTime());
    expect(read.updateTime.getTime()).toBe(WRITTEN_AT.getTime());
  });

  it('reports no change when nothing changed', async () => {
    const em = orm.em.fork();
    await em.findOneOrFail(StorageSession, {id: 'session-id'});

    em.getUnitOfWork().computeChangeSets();

    expect(em.getUnitOfWork().getChangeSets()).toHaveLength(0);
  });
});
