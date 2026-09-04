/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sessions: migrate a legacy pickle database
 *
 * Copies an adk-python v0 (pickle) sessions database into a v1 (JSON) one and
 * reads the result back with `DatabaseSessionService`, which refuses to open
 * the v0 layout.
 *
 * With no environment set, the script writes a small v0 database of its own in
 * a temporary directory, so it runs offline and needs no API key:
 *
 *   npx tsx samples/sessions/migrate_pickle_db/migrate.ts
 *
 * Set ADK_SOURCE_DB_URL and ADK_DEST_DB_URL to migrate a real database
 * instead. See the README in this directory.
 */

import {DatabaseSessionService, getLogger, migrate} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const logger = getLogger();

/**
 * `EventActions(state_delta={'skey': 4})`, pickled by CPython. A v0 database
 * stores this byte-for-byte in `events.actions`, which is the column the
 * migration exists to convert; every other column is already JSON.
 */
const PICKLED_ACTIONS =
  'gAWVRwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjARza2V5lEsEc4wOYXJ0aWZhY3RfZGVsdGGUfZSMEXRyYW5zZmVyX3RvX2FnZW50lE6MCGVzY2FsYXRllE6MFnJlcXVlc3RlZF9hdXRoX2NvbmZpZ3OUfZSMHHJlcXVlc3RlZF90b29sX2NvbmZpcm1hdGlvbnOUfZSMCmNvbXBhY3Rpb26UTnWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoCJCMFF9fcHlkYW50aWNfcHJpdmF0ZV9flE51Yi4=';

const APP_NAME = 'demo_app';
const USER_ID = 'demo_user';
const SESSION_ID = 'demo_session';
const TIMESTAMP = '2026-01-01 12:00:00.000000';

/** Writes the v0 tables and one session's worth of rows into `dbPath`. */
async function createLegacyDatabase(dbPath: string): Promise<void> {
  const orm = await MikroORM.init({
    // The v0 layout has no ORM entities in adk-js; it is written with raw SQL,
    // exactly as the migration reads it.
    entities: [],
    discovery: {warnWhenNoEntities: false},
    dbName: dbPath,
    driver: SqliteDriver,
  });
  const connection = orm.em.getConnection();
  try {
    await connection.execute(
      `CREATE TABLE sessions (
         app_name TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL,
         state TEXT, create_time TEXT NOT NULL, update_time TEXT NOT NULL,
         PRIMARY KEY (app_name, user_id, id))`,
    );
    await connection.execute(
      `CREATE TABLE events (
         id TEXT NOT NULL, app_name TEXT NOT NULL, user_id TEXT NOT NULL,
         session_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
         author TEXT NOT NULL, actions BLOB, timestamp TEXT NOT NULL,
         PRIMARY KEY (id, app_name, user_id, session_id))`,
    );
    await connection.execute(
      'INSERT INTO sessions (app_name, user_id, id, state, create_time,' +
        ' update_time) VALUES (?, ?, ?, ?, ?, ?)',
      [
        APP_NAME,
        USER_ID,
        SESSION_ID,
        JSON.stringify({visits: 1}),
        TIMESTAMP,
        TIMESTAMP,
      ],
    );
    await connection.execute(
      'INSERT INTO events (id, app_name, user_id, session_id, invocation_id,' +
        ' author, actions, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'event1',
        APP_NAME,
        USER_ID,
        SESSION_ID,
        'invoke1',
        'user',
        Buffer.from(PICKLED_ACTIONS, 'base64'),
        TIMESTAMP,
      ],
    );
  } finally {
    await orm.close(true);
  }
}

/** Reads the migrated database back through the service that will use it. */
async function reportMigrated(destDbUrl: string): Promise<void> {
  const service = new DatabaseSessionService(destDbUrl);
  const session = await service.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (session === undefined) {
    logger.error(`No session ${SESSION_ID} in the migrated database.`);
    return;
  }
  logger.info(`Recovered session state: ${JSON.stringify(session.state)}`);
  for (const event of session.events) {
    logger.info(
      `Event ${event.id} state delta: ` +
        JSON.stringify(event.actions.stateDelta),
    );
  }
}

async function main(): Promise<void> {
  const sourceDbUrl = process.env['ADK_SOURCE_DB_URL'];
  const destDbUrl = process.env['ADK_DEST_DB_URL'];
  if (sourceDbUrl !== undefined && destDbUrl !== undefined) {
    await migrate({sourceDbUrl, destDbUrl});
    await reportMigrated(destDbUrl);
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'adk-pickle-demo-'));
  try {
    const legacyPath = join(workDir, 'legacy_sessions.db');
    const migratedUrl = `sqlite://${join(workDir, 'sessions.db')}`;
    await createLegacyDatabase(legacyPath);
    await migrate({
      sourceDbUrl: `sqlite://${legacyPath}`,
      destDbUrl: migratedUrl,
    });
    await reportMigrated(migratedUrl);
  } finally {
    await rm(workDir, {recursive: true, force: true});
  }
}

await main();
