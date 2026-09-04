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

import {MikroORM, Options} from '@mikro-orm/core';
import {MariaDbDriver, MariaDbPlatform} from '@mikro-orm/mariadb';
import {MsSqlDriver} from '@mikro-orm/mssql';
import {MySqlDriver} from '@mikro-orm/mysql';
import {PostgreSqlDriver} from '@mikro-orm/postgresql';
import {SqliteDriver, SqlitePlatform} from '@mikro-orm/sqlite';
import {describe, expect, it} from 'vitest';
import {ENTITIES} from '../../../src/sessions/db/schema.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  DynamicJsonType,
  PreciseTimestampType,
  dynamicJsonColumnType,
  preciseTimestampColumnType,
} from '../../../src/sessions/db/shared.js';

/** The driver each backend uses, and the session columns it must declare. */
const BACKENDS = {
  sqlite: {
    driver: SqliteDriver,
    columns: [
      '`state` text',
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
      '"create_time" timestamptz(6)',
      '"update_time" timestamptz(6)',
    ],
  },
  mssql: {
    driver: MsSqlDriver,
    columns: [
      '[state] text',
      '[create_time] datetime2(6)',
      '[update_time] datetime2(6)',
    ],
  },
} satisfies Record<string, {driver: Options['driver']; columns: string[]}>;

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
  it('groups MariaDB with MySQL', () => {
    const mariadb = new MariaDbPlatform();

    expect(dynamicJsonColumnType(mariadb)).toBe('longtext');
    expect(preciseTimestampColumnType(mariadb)).toBe('datetime(6)');
  });

  it('reads a POSIX epoch as seconds, not milliseconds', () => {
    expect(
      new PreciseTimestampType().convertToJSValue(1, new SqlitePlatform()),
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
});
