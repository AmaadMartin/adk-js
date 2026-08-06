/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ENTITIES,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageEvent,
  StorageSession,
} from '../../../src/sessions/db/schema.js';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

describe('storage schema', () => {
  let orm: MikroORM;

  beforeEach(async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      driver: SqliteDriver,
      entities: ENTITIES,
    });
    await orm.schema.createSchema();
  });

  afterEach(async () => {
    await orm.close();
  });

  async function createStorageSession(id = SESSION_ID): Promise<void> {
    const em = orm.em.fork();
    em.create(StorageSession, {
      id,
      appName: APP_NAME,
      userId: USER_ID,
      state: {},
    });
    await em.flush();
  }

  async function createStorageEvent(
    id: string,
    sessionId = SESSION_ID,
  ): Promise<void> {
    const em = orm.em.fork();
    const session = em.getReference(StorageSession, [
      APP_NAME,
      USER_ID,
      sessionId,
    ]);
    em.create(StorageEvent, {
      id,
      session,
      invocationId: `invocation-${id}`,
      timestamp: new Date(),
      eventData: createEvent({id}),
    });
    await em.flush();
  }

  async function countEvents(): Promise<number> {
    return orm.em.fork().count(StorageEvent, {});
  }

  it('keeps events composite key columns within the MySQL index limit', async () => {
    // `session` owns app_name, user_id and session_id, so these two
    // properties emit every key column of the events table.
    const eventProperties = orm.getMetadata().get(StorageEvent.name)
      .properties as Record<string, {length?: number; fieldNames: string[]}>;
    const keyColumnLengths = ['id', 'session'].flatMap((keyProperty) => {
      const property = eventProperties[keyProperty];
      return property.fieldNames.map(() => property.length);
    });

    expect(keyColumnLengths).toEqual(Array(4).fill(STORAGE_KEY_COLUMN_LENGTH));

    const utf8mb4KeyBytes = keyColumnLengths.reduce<number>(
      (total, length) => total + (length ?? 0) * 4,
      0,
    );
    expect(utf8mb4KeyBytes).toBeLessThanOrEqual(3072);
  });

  it('declares an events -> sessions foreign key that cascades on delete', async () => {
    const sql = await orm.schema.getCreateSchemaSQL();

    expect(sql).toContain(
      'foreign key(`app_name`, `user_id`, `session_id`) ' +
        'references `sessions`(`app_name`, `user_id`, `id`) ' +
        'on delete cascade on update cascade',
    );
  });

  it('keeps the events primary key columns in their original order', async () => {
    const sql = await orm.schema.getCreateSchemaSQL();

    expect(sql).toContain(
      'primary key (`id`, `app_name`, `user_id`, `session_id`)',
    );
  });

  it('deletes the events when the session row alone is deleted', async () => {
    await createStorageSession();
    await createStorageEvent('event-1');
    await createStorageEvent('event-2');
    expect(await countEvents()).toBe(2);

    await orm.em
      .getConnection()
      .execute(
        'DELETE FROM sessions WHERE app_name = ? AND user_id = ? AND id = ?',
        [APP_NAME, USER_ID, SESSION_ID],
      );

    expect(await countEvents()).toBe(0);
  });

  it('rejects an event that names a session which does not exist', async () => {
    await expect(
      createStorageEvent('orphan-event', 'missing-session'),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('enforces foreign keys on a SQLite connection without an app-level pragma', async () => {
    const rows = await orm.em
      .getConnection()
      .execute<Array<{foreign_keys: number}>>('pragma foreign_keys');

    expect(rows[0].foreign_keys).toBe(1);
  });

  it('reads and deletes events through the non-persistent key mirrors', async () => {
    await createStorageSession();
    await createStorageEvent('event-1');

    const em = orm.em.fork();
    const found = await em.find(StorageEvent, {
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(found).toHaveLength(1);
    expect(found[0].appName).toBe(APP_NAME);
    expect(found[0].userId).toBe(USER_ID);
    expect(found[0].sessionId).toBe(SESSION_ID);
    expect(found[0].eventData.id).toBe('event-1');

    const deleted = await em.nativeDelete(StorageEvent, {
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(deleted).toBe(1);
    expect(await countEvents()).toBe(0);
  });
});
