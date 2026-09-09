/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM} from '@mikro-orm/core';
import {MySqlDriver} from '@mikro-orm/mysql';
import {afterEach, describe, expect, it} from 'vitest';
import {ENTITIES} from '../../../src/sessions/db/schema.js';

/** Every temporal column the session service writes, as `table.column`. */
const TEMPORAL_COLUMNS = [
  ['sessions', 'create_time'],
  ['sessions', 'update_time'],
  ['events', 'timestamp'],
  ['app_states', 'update_time'],
  ['user_states', 'update_time'],
] as const;

/** Reads the type a `create table` statement declares for one column. */
function columnType(sql: string, table: string, column: string): string {
  const statement = sql
    .split(';')
    .find((candidate) => candidate.includes(`create table \`${table}\``))!;
  return statement.match(new RegExp(`\`${column}\` ([^ ,]+)`))![1];
}

describe('storage schema DDL', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) {
      await orm.close();
    }
  });

  it('emits MySQL datetime(6) for every temporal column', async () => {
    // The constructor is MikroORM v7's non-connecting init, which `connect:
    // false` used to request. The schema SQL comes from metadata alone, so no
    // MySQL server has to be reachable.
    orm = new MikroORM({
      driver: MySqlDriver,
      entities: ENTITIES,
      dbName: 'adk',
      allowGlobalContext: true,
    });

    const sql = await orm.schema.getCreateSchemaSQL({wrap: false});
    const columnTypes = Object.fromEntries(
      TEMPORAL_COLUMNS.map(([table, column]) => [
        `${table}.${column}`,
        columnType(sql, table, column),
      ]),
    );

    expect(columnTypes).toEqual({
      'sessions.create_time': 'datetime(6)',
      'sessions.update_time': 'datetime(6)',
      'events.timestamp': 'datetime(6)',
      'app_states.update_time': 'datetime(6)',
      'user_states.update_time': 'datetime(6)',
    });
  });
});
