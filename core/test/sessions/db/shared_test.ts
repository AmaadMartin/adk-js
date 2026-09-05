/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/sessions/test_schemas_shared.py` from
 * google/adk-python, read at commit 30e0a2675689.
 *
 * Each `it` keeps its Python test name so a reader can grep the two suites
 * against each other. The reference drives a stand-in SQLAlchemy dialect; this
 * suite drives the real MikroORM platform for each backend instead.
 */

import {DateTimeType, EntityProperty, MikroORM} from '@mikro-orm/core';
import {MsSqlPlatform} from '@mikro-orm/mssql';
import {MySqlPlatform} from '@mikro-orm/mysql';
import {PostgreSqlPlatform} from '@mikro-orm/postgresql';
import {SqliteDriver, SqlitePlatform} from '@mikro-orm/sqlite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {ENTITIES, StorageSession} from '../../../src/sessions/db/schema.js';
import {
  DynamicJsonType,
  PreciseTimestampType,
  dynamicJsonColumnType,
  preciseTimestampColumnType,
} from '../../../src/sessions/db/shared.js';

const PLATFORMS = {
  postgresql: new PostgreSqlPlatform(),
  mysql: new MySqlPlatform(),
  mssql: new MsSqlPlatform(),
  sqlite: new SqlitePlatform(),
};

describe('session storage column types', () => {
  const dynamicJson = new DynamicJsonType();
  const preciseTimestamp = new PreciseTimestampType();
  let orm: MikroORM;
  let timestampProp: EntityProperty;

  beforeAll(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
      connect: false,
      allowGlobalContext: true,
    });
    timestampProp = orm.getMetadata().get(StorageSession).properties.updateTime;
  });

  afterAll(async () => {
    await orm.close();
  });

  it('test_dynamic_json_load_dialect_impl[postgresql]', () => {
    expect(dynamicJsonColumnType(PLATFORMS.postgresql)).toBe('jsonb');
  });

  it('test_dynamic_json_load_dialect_impl[mysql]', () => {
    expect(dynamicJsonColumnType(PLATFORMS.mysql)).toBe('longtext');
  });

  it('test_dynamic_json_load_dialect_impl[sqlite]', () => {
    expect(dynamicJsonColumnType(PLATFORMS.sqlite)).toBe('text');
  });

  it('test_dynamic_json_serializes_to_json_text_for_non_postgresql', () => {
    const value = {key: 'value', nested: [1, 2, {deep: true}]};

    const bound = dynamicJson.convertToDatabaseValue(value, PLATFORMS.sqlite);

    expect(bound).toBe(JSON.stringify(value));
    expect(dynamicJson.convertToJSValue(bound)).toEqual(value);
  });

  /**
   * Adapted. The reference passes the object straight to psycopg, which wants
   * a dict for a `jsonb` bind parameter. MikroORM serializes JSON on every
   * platform, PostgreSQL included, and types the database value as
   * `string | null`. Only the read direction stays an identity, which is what
   * the `pg` driver hands back for a `jsonb` column.
   */
  it('test_dynamic_json_passes_values_through_for_postgresql', () => {
    const value = {key: 'value'};

    expect(
      dynamicJson.convertToDatabaseValue(value, PLATFORMS.postgresql),
    ).toBe(JSON.stringify(value));
    expect(dynamicJson.convertToJSValue(value)).toBe(value);
  });

  it('test_dynamic_json_keeps_none_as_sql_null[sqlite]', () => {
    expect(
      dynamicJson.convertToDatabaseValue(null, PLATFORMS.sqlite),
    ).toBeNull();
    expect(dynamicJson.convertToJSValue(null)).toBeNull();
  });

  it('test_dynamic_json_keeps_none_as_sql_null[postgresql]', () => {
    expect(
      dynamicJson.convertToDatabaseValue(null, PLATFORMS.postgresql),
    ).toBeNull();
    expect(dynamicJson.convertToJSValue(null)).toBeNull();
  });

  it('test_precise_timestamp_load_dialect_impl_mysql_keeps_microseconds', () => {
    expect(preciseTimestampColumnType(PLATFORMS.mysql)).toBe('datetime(6)');
  });

  it('test_precise_timestamp_load_dialect_impl_defaults_to_datetime', () => {
    expect(
      preciseTimestamp.getColumnType(timestampProp, PLATFORMS.sqlite),
    ).toBe(new DateTimeType().getColumnType(timestampProp, PLATFORMS.sqlite));
  });

  it('test_precise_timestamp_result_processor_reads_epoch_as_utc[float]', () => {
    const raw = 1767322475.123456;

    expect(preciseTimestamp.convertToJSValue(raw, PLATFORMS.sqlite)).toEqual(
      new Date(raw * 1000),
    );
  });

  it('test_precise_timestamp_result_processor_reads_epoch_as_utc[int]', () => {
    expect(
      preciseTimestamp.convertToJSValue(1767322475, PLATFORMS.sqlite),
    ).toEqual(new Date(1767322475000));
  });

  it('test_precise_timestamp_result_processor_keeps_none', () => {
    expect(
      preciseTimestamp.convertToJSValue(null, PLATFORMS.sqlite),
    ).toBeNull();
  });

  /**
   * Adapted. MikroORM has no separate implementation processor to stub, so
   * this asserts that a value the driver hands back untouched reaches the
   * caller as the same instant, and that an existing `Date` is not rebuilt.
   */
  it('test_precise_timestamp_result_processor_delegates_non_numeric_values', () => {
    const existing = new Date('2026-01-02T03:04:05.123Z');

    expect(
      preciseTimestamp.convertToJSValue(
        '2026-01-02T03:04:05.123Z',
        PLATFORMS.sqlite,
      ),
    ).toEqual(existing);
    expect(preciseTimestamp.convertToJSValue(existing, PLATFORMS.sqlite)).toBe(
      existing,
    );
  });

  it('test_precise_timestamp_uses_datetime2_on_mssql', () => {
    expect(preciseTimestampColumnType(PLATFORMS.mssql)).toBe('datetime2(6)');
  });
});
