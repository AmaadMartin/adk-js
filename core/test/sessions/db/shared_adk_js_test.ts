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
import {SqliteDriver} from '@mikro-orm/sqlite';
import {describe, expect, it} from 'vitest';
import {ENTITIES} from '../../../src/sessions/db/schema.js';
import {
  DEFAULT_MAX_VARCHAR_LENGTH,
  DynamicJsonType,
  dynamicJsonColumnType,
  posixSecondsToDate,
  preciseTimestampColumnType,
} from '../../../src/sessions/db/shared.js';

/** Drivers keyed by the connection-string scheme that selects them. */
const DRIVERS = {
  sqlite: SqliteDriver,
  mysql: MySqlDriver,
  mariadb: MariaDbDriver,
  postgresql: PostgreSqlDriver,
  mssql: MsSqlDriver,
} satisfies Record<string, Options['driver']>;

type Backend = keyof typeof DRIVERS;

/** The column types each backend must declare for the `sessions` table. */
const EXPECTED_SESSION_COLUMNS: Record<Backend, string[]> = {
  sqlite: ['`state` text', '`create_time` datetime', '`update_time` datetime'],
  mysql: [
    '`state` longtext',
    '`create_time` datetime(6)',
    '`update_time` datetime(6)',
  ],
  mariadb: [
    '`state` longtext',
    '`create_time` datetime(6)',
    '`update_time` datetime(6)',
  ],
  postgresql: [
    '"state" jsonb',
    '"create_time" timestamptz(6)',
    '"update_time" timestamptz(6)',
  ],
  mssql: [
    '[state] text',
    '[create_time] datetime2(6)',
    '[update_time] datetime2(6)',
  ],
};

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
    expect(posixSecondsToDate(1)).toEqual(new Date(1000));
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

  it.for(Object.keys(DRIVERS) as Backend[])(
    'declares the session columns %s expects',
    async (backend) => {
      const sql = await createSchemaSql(DRIVERS[backend]);

      for (const column of EXPECTED_SESSION_COLUMNS[backend]) {
        expect(sql).toContain(column);
      }
    },
  );

  it('bounds the metadata value column', async () => {
    const sql = await createSchemaSql(DRIVERS.mysql);

    expect(sql).toContain(`\`value\` varchar(${DEFAULT_MAX_VARCHAR_LENGTH})`);
  });
});
