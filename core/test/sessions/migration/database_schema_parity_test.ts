/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from `google/adk-python` `main`:
 * `tests/unittests/sessions/migration/test_database_schema.py`, read at
 * commit `a3bd1115`. The original test names are kept so a reviewer can grep
 * for them there.
 *
 * The reference reads the schema through SQLAlchemy's `inspect`. MikroORM's
 * core package exposes no portable reflection, so these read `sqlite_master`
 * and `pragma table_info` instead, which is what the rest of this suite does.
 */

import {DatabaseSessionService} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  EVENTS_TABLE_NAME,
  EVENTS_TIMESTAMP_INDEX_NAME,
  METADATA_TABLE_NAME,
} from '../../../src/sessions/db/schema.js';
import {ENTITIES_V0} from '../../../src/sessions/db/schema_v0.js';

const APP_NAME = 'my_app';
const USER_ID = 'test_user';

/** Opens a throwaway MikroORM connection on a sqlite file. */
async function openInspector(file: string): Promise<MikroORM> {
  return MikroORM.init({
    dbName: file,
    driver: SqliteDriver,
    entities: ENTITIES_V0,
    pool: {min: 1, max: 1},
    allowGlobalContext: true,
  });
}

/** Runs one statement against a sqlite file, then closes the connection. */
async function runDdl(file: string, statement: string): Promise<void> {
  const orm = await openInspector(file);
  await orm.em.getConnection().execute(statement, [], 'run');
  await orm.close();
}

/** Reads what a sqlite file holds, the way the reference inspects it. */
async function inspectDatabase(file: string): Promise<{
  tables: string[];
  eventColumns: string[];
  eventIndexes: string[];
}> {
  const orm = await openInspector(file);
  const connection = orm.em.getConnection();
  const tables: Array<{name: string}> = await connection.execute(
    "select name from sqlite_master where type = 'table'",
  );
  const eventColumns: Array<{name: string}> = await connection.execute(
    `pragma table_info('${EVENTS_TABLE_NAME}')`,
  );
  const eventIndexes: Array<{name: string}> = await connection.execute(
    `select name from sqlite_master where type = 'index' and tbl_name = ` +
      `'${EVENTS_TABLE_NAME}'`,
  );
  await orm.close();
  return {
    tables: tables.map((row) => row.name),
    eventColumns: eventColumns.map((row) => row.name),
    eventIndexes: eventIndexes.map((row) => row.name),
  };
}

/** Writes the v0 tables and indexes, as the reference's `create_v0_db` does. */
async function createV0Database(file: string): Promise<void> {
  const orm = await openInspector(file);
  await orm.schema.createSchema();
  await orm.close();
}

describe('database schema selection, ported from adk-python', () => {
  let directory: string;
  let databaseFile: string;
  let service: DatabaseSessionService | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'adk-schema-parity-'));
    databaseFile = join(directory, 'sessions.db');
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await rm(directory, {recursive: true, force: true});
  });

  it('test_new_db_uses_latest_schema', async () => {
    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.createSession({appName: APP_NAME, userId: USER_ID});
    await service.close();
    service = undefined;

    const {tables, eventColumns, eventIndexes} =
      await inspectDatabase(databaseFile);

    expect(tables).toContain(METADATA_TABLE_NAME);
    expect(eventColumns).toContain('event_data');
    expect(eventColumns).not.toContain('actions');
    expect(eventIndexes).toContain(EVENTS_TIMESTAMP_INDEX_NAME);
  });

  it('test_existing_v0_db_uses_v0_schema', async () => {
    await createV0Database(databaseFile);

    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    await service.close();
    service = undefined;

    expect(session?.id).toBe('s1');
    const {tables, eventColumns} = await inspectDatabase(databaseFile);
    expect(tables).not.toContain(METADATA_TABLE_NAME);
    expect(eventColumns).not.toContain('event_data');
    expect(eventColumns).toContain('actions');
  });

  it('test_existing_latest_db_uses_latest_schema', async () => {
    const first = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await first.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    await first.close();

    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.createSession({
      appName: APP_NAME,
      userId: 'test_user2',
      sessionId: 's2',
    });
    const s2 = await service.getSession({
      appName: APP_NAME,
      userId: 'test_user2',
      sessionId: 's2',
    });
    const s1 = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    const listed = await service.listSessions({appName: APP_NAME});
    await service.close();
    service = undefined;

    expect(s2?.id).toBe('s2');
    expect(s1?.id).toBe('s1');
    expect(listed.sessions).toHaveLength(2);
    const {tables, eventColumns} = await inspectDatabase(databaseFile);
    expect(tables).toContain(METADATA_TABLE_NAME);
    expect(eventColumns).toContain('event_data');
    expect(eventColumns).not.toContain('actions');
  });

  it('test_prepare_tables_recreates_missing_latest_events_index', async () => {
    const first = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await first.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    await first.close();
    await runDdl(databaseFile, `drop index ${EVENTS_TIMESTAMP_INDEX_NAME}`);

    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    await service.close();
    service = undefined;

    expect(session?.id).toBe('s1');
    const {eventIndexes} = await inspectDatabase(databaseFile);
    expect(eventIndexes).toContain(EVENTS_TIMESTAMP_INDEX_NAME);
  });

  it('test_prepare_tables_recreates_missing_v0_events_index', async () => {
    await createV0Database(databaseFile);
    await runDdl(databaseFile, `drop index ${EVENTS_TIMESTAMP_INDEX_NAME}`);

    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    const session = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 's1',
    });
    await service.close();
    service = undefined;

    expect(session?.id).toBe('s1');
    const {tables, eventIndexes} = await inspectDatabase(databaseFile);
    expect(eventIndexes).toContain(EVENTS_TIMESTAMP_INDEX_NAME);
    expect(tables).not.toContain(METADATA_TABLE_NAME);
  });
});
