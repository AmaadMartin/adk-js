/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the naive-datetime handling against a real sqlite database under a
 * non-UTC process timezone. A half-hour zone is used so that a sign error or a
 * rounding error cannot pass by coincidence.
 */

import {createEvent, DatabaseSessionService} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {getConnectionOptionsFromUri} from '../../src/sessions/db/operations.js';

const NON_UTC_TIMEZONE = 'Asia/Kolkata';
process.env.TZ = NON_UTC_TIMEZONE;

const APP_NAME = 'naive-datetime-app';
const USER_ID = 'naive-datetime-user';
const SESSION_ID = 'naive-datetime-session';

/** An update time in the zone-less shape SQLAlchemy writes for adk-python. */
const PYTHON_WRITTEN_UPDATE_TIME = '2026-09-04 12:00:00.000000';

/** The instant {@link PYTHON_WRITTEN_UPDATE_TIME} means. */
const PYTHON_WRITTEN_INSTANT = Date.UTC(2026, 8, 4, 12, 0, 0);

/** Overwrites the stored update time with the string adk-python would write. */
async function writePythonUpdateTime(uri: string): Promise<void> {
  const orm = await MikroORM.init(await getConnectionOptionsFromUri(uri));
  try {
    await orm.em
      .getConnection()
      .execute('update sessions set update_time = ? where id = ?', [
        PYTHON_WRITTEN_UPDATE_TIME,
        SESSION_ID,
      ]);
  } finally {
    await orm.close();
  }
}

describe('DatabaseSessionService naive datetime handling', () => {
  let directory: string;
  let dbPath: string;
  let uri: string;
  let service: DatabaseSessionService;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'adk-naive-datetime-'));
    dbPath = path.join(directory, 'sessions.db');
    uri = `sqlite://${dbPath}`;
    service = new DatabaseSessionService(uri);
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, {recursive: true, force: true});
  });

  async function createTestSession(): Promise<void> {
    await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  }

  function loadTestSession() {
    return service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  }

  it('runs under a non-UTC process timezone', () => {
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });

  it('reads a zone-less timestamp adk-python wrote as UTC', async () => {
    await createTestSession();
    await writePythonUpdateTime(uri);

    const loaded = await loadTestSession();

    expect(loaded?.lastUpdateTime).toBe(PYTHON_WRITTEN_INSTANT);
  });

  it('defaults an options object to UTC as well', async () => {
    await service.close();
    service = new DatabaseSessionService({
      dbName: dbPath,
      driver: SqliteDriver,
    });
    await createTestSession();
    await writePythonUpdateTime(uri);

    const loaded = await loadTestSession();

    expect(loaded?.lastUpdateTime).toBe(PYTHON_WRITTEN_INSTANT);
  });

  it('lets an options object keep the process timezone', async () => {
    await service.close();
    service = new DatabaseSessionService({
      dbName: dbPath,
      driver: SqliteDriver,
      forceUtcTimezone: false,
    });
    await createTestSession();
    await writePythonUpdateTime(uri);

    const loaded = await loadTestSession();

    expect(loaded?.lastUpdateTime).toBe(
      new Date(PYTHON_WRITTEN_UPDATE_TIME).getTime(),
    );
  });

  it('keeps the sqlite epoch representation adk-js already writes', async () => {
    await createTestSession();

    const orm = await MikroORM.init(await getConnectionOptionsFromUri(uri));
    try {
      const rows = await orm.em
        .getConnection()
        .execute<
          Array<{update_time: unknown}>
        >('select update_time from sessions where id = ?', [SESSION_ID]);

      expect(typeof rows[0].update_time).toBe('number');
    } finally {
      await orm.close();
    }
  });

  it('reads back the instant createSession wrote', async () => {
    const created = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const loaded = await loadTestSession();

    expect(loaded?.lastUpdateTime).toBe(created.lastUpdateTime);
  });

  it('appends an event to a session it just created', async () => {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const appended = await service.appendEvent({
      session,
      event: createEvent({author: 'user', invocationId: 'invocation-1'}),
    });

    const loaded = await loadTestSession();

    expect(loaded?.events.map((event) => event.id)).toEqual([appended.id]);
  });

  it('generates the same sqlite schema with and without the UTC option', async () => {
    const options = await getConnectionOptionsFromUri(uri);
    const naive = await MikroORM.init(options);
    const local = await MikroORM.init({...options, forceUtcTimezone: false});
    try {
      expect(await naive.schema.getCreateSchemaSQL()).toBe(
        await local.schema.getCreateSchemaSQL(),
      );
    } finally {
      await naive.close();
      await local.close();
    }
  });
});

/**
 * The dialects adk-python parametrises
 * `test_database_session_service_uses_naive_datetime_for_dialect` over, with a
 * URI for each. adk-python asks its engine for the dialect name; adk-js reads
 * the backend out of the URI, so the equivalent assertion is that the
 * connection the URI produces carries the UTC option.
 */
const REFERENCE_NAIVE_URIS: ReadonlyArray<[string, string]> = [
  ['sqlite', 'sqlite://:memory:'],
  ['postgresql', 'postgresql://user:pass@localhost:5432/db'],
  ['mysql', 'mysql://user:pass@localhost:3306/db'],
  ['mariadb', 'mariadb://user:pass@localhost:3306/db'],
];

describe('getConnectionOptionsFromUri timezone handling', () => {
  for (const [dialect, uri] of REFERENCE_NAIVE_URIS) {
    it(`test_database_session_service_uses_naive_datetime_for_dialect[${dialect}]`, async () => {
      const options = await getConnectionOptionsFromUri(uri);

      expect(options.forceUtcTimezone).toBe(true);
    });
  }

  it('asks SQL Server for UTC, which adk-python does not enumerate', async () => {
    const options = await getConnectionOptionsFromUri(
      'mssql://user:pass@localhost:1433/db',
    );

    expect(options.forceUtcTimezone).toBe(true);
  });

  it('lets a caller override the UTC default', async () => {
    const options = await getConnectionOptionsFromUri(
      'mysql://user:pass@localhost:3306/db',
      {forceUtcTimezone: false},
    );

    expect(options.forceUtcTimezone).toBe(false);
  });
});
