/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The legacy v0 write path, which has no counterpart in adk-python's test
 * suite: Python selects the v0 or v1 ORM classes per call on one engine, so
 * writing a v0 database is the same code path there. adk-js registers a
 * different entity set instead, so each write needs its own coverage.
 */

import {
  createEvent,
  createEventActions,
  createSession,
  DatabaseSessionService,
  Session,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ENTITIES_V0,
  StorageEventV0,
  storageEventV0ToEvent,
} from '../../src/sessions/db/schema_v0.js';

const APP_NAME = 'legacy-write-app';
const USER_ID = 'legacy-write-user';

/** Opens a throwaway connection carrying the legacy entity set. */
async function openLegacyOrm(file: string): Promise<MikroORM> {
  return MikroORM.init({
    dbName: file,
    driver: SqliteDriver,
    entities: ENTITIES_V0,
    pool: {min: 1, max: 1},
    allowGlobalContext: true,
  });
}

/** Reads the stored v0 rows of one session, oldest first. */
async function readLegacyRows(
  file: string,
  sessionId: string,
): Promise<StorageEventV0[]> {
  const orm = await openLegacyOrm(file);
  const rows = await orm.em
    .fork()
    .find(
      StorageEventV0,
      {appName: APP_NAME, userId: USER_ID, sessionId},
      {orderBy: {timestamp: 'ASC', id: 'ASC'}},
    );
  // Detach from the entity manager before it closes, so the rows stay
  // readable after this returns.
  const detached = rows.map((row) => Object.assign(new StorageEventV0(), row));
  await orm.close();
  return detached;
}

describe('DatabaseSessionService writing a legacy v0 database', () => {
  let directory: string;
  let databaseFile: string;
  let service: DatabaseSessionService;
  let session: Session;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'adk-v0-write-'));
    databaseFile = join(directory, 'legacy.db');

    const seed = await openLegacyOrm(databaseFile);
    await seed.schema.createSchema();
    await seed.close();

    service = new DatabaseSessionService(`sqlite://${databaseFile}`);
    session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'v0-session',
    });
  });

  afterEach(async () => {
    await service.close();
    await rm(directory, {recursive: true, force: true});
  });

  it('round-trips an event and its actions', async () => {
    const actions = createEventActions({
      stateDelta: {topic: 'pickles'},
      artifactDelta: {'report.pdf': 3},
      transferToAgent: 'reviewer',
      skipSummarization: true,
    });

    const appended = await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 5000, actions}),
    });

    const reloaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'v0-session',
    });
    expect(reloaded?.events.map((event) => event.id)).toEqual([appended.id]);
    expect(reloaded?.events[0].actions).toEqual(actions);
    expect(reloaded?.events[0].author).toBe('user');
  });

  it('writes an actions pickle the v0 reader decodes back', async () => {
    const actions = createEventActions({
      stateDelta: {stage: 'review'},
      escalate: true,
    });

    await service.appendEvent({
      session,
      event: createEvent({author: 'agent', timestamp: 6000, actions}),
    });

    const [row] = await readLegacyRows(databaseFile, 'v0-session');
    expect(row.actions).toBeInstanceOf(Buffer);
    expect(storageEventV0ToEvent(row).actions).toEqual(actions);
  });

  it('rewrites the row of an event whose id is already stored', async () => {
    const event = createEvent({author: 'user', timestamp: 7000});
    await service.appendEvent({session, event});

    const replacement = createEvent({
      id: event.id,
      author: 'user',
      timestamp: 8000,
      actions: createEventActions({stateDelta: {stage: 'done'}}),
    });
    await service.appendEvent({session, event: replacement});

    const rows = await readLegacyRows(databaseFile, 'v0-session');
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp.getTime()).toBe(8000);
    expect(storageEventV0ToEvent(rows[0]).actions.stateDelta).toEqual({
      stage: 'done',
    });
  });

  it('accepts a marker-less session that holds the newest stored event', async () => {
    const first = await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 9000}),
    });

    // A session built by hand carries no revision marker, so `appendEvent`
    // falls back to comparing the newest stored event. That read goes through
    // the legacy entity, which MikroORM only knows on this connection.
    const handBuilt = createSession({
      id: session.id,
      appName: APP_NAME,
      userId: USER_ID,
      events: [first],
      lastUpdateTime: 1,
    });

    const second = await service.appendEvent({
      session: handBuilt,
      event: createEvent({author: 'user', timestamp: 10000}),
    });

    const rows = await readLegacyRows(databaseFile, 'v0-session');
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it('rejects a marker-less session that lost the newest stored event', async () => {
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 11000}),
    });

    const stale = createSession({
      id: session.id,
      appName: APP_NAME,
      userId: USER_ID,
      lastUpdateTime: 1,
    });

    await expect(
      service.appendEvent({
        session: stale,
        event: createEvent({author: 'user', timestamp: 12000}),
      }),
    ).rejects.toThrow('modified in storage');
  });

  it('rejects actions holding a value with no Python counterpart', async () => {
    await expect(
      service.appendEvent({
        session,
        event: createEvent({
          author: 'user',
          timestamp: 13000,
          actions: createEventActions({stateDelta: {when: new Date(0)}}),
        }),
      }),
    ).rejects.toThrow(/Cannot write an instance of Date as a pickled value/);

    expect(await readLegacyRows(databaseFile, 'v0-session')).toEqual([]);
  });

  it('deletes a session and the legacy rows it owns', async () => {
    await service.appendEvent({
      session,
      event: createEvent({author: 'user', timestamp: 14000}),
    });

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'v0-session',
    });

    await expect(
      service.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'v0-session',
      }),
    ).resolves.toBeUndefined();
    expect(await readLegacyRows(databaseFile, 'v0-session')).toEqual([]);
  });
});
