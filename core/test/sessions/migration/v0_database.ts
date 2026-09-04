/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds a legacy v0 (pickle) sessions database for the migration tests.
 *
 * The DDL mirrors `google/adk-python`'s
 * `src/google/adk/sessions/schemas/v0.py` as SQLAlchemy's SQLite dialect
 * emits it: a naive timestamp is text, a JSON column is text, and
 * `events.actions` is a BLOB holding a Python pickle.
 */

import {MikroORM} from '@mikro-orm/core';
import {getConnectionOptionsFromUri} from '../../../src/sessions/db/operations.js';

/** Timestamp text in the shape SQLAlchemy's SQLite dialect writes. */
export const V0_TIMESTAMP = '2026-01-01 12:00:00.000000';

const V0_DDL: readonly string[] = [
  `CREATE TABLE app_states (
     app_name TEXT NOT NULL PRIMARY KEY,
     state TEXT,
     update_time TEXT NOT NULL
   )`,
  `CREATE TABLE user_states (
     app_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     state TEXT,
     update_time TEXT NOT NULL,
     PRIMARY KEY (app_name, user_id)
   )`,
  `CREATE TABLE sessions (
     app_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     id TEXT NOT NULL,
     state TEXT,
     create_time TEXT NOT NULL,
     update_time TEXT NOT NULL,
     PRIMARY KEY (app_name, user_id, id)
   )`,
  `CREATE TABLE events (
     id TEXT NOT NULL,
     app_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     invocation_id TEXT NOT NULL,
     author TEXT NOT NULL,
     actions BLOB,
     long_running_tool_ids_json TEXT,
     branch TEXT,
     timestamp TEXT NOT NULL,
     content TEXT,
     grounding_metadata TEXT,
     custom_metadata TEXT,
     usage_metadata TEXT,
     citation_metadata TEXT,
     partial INTEGER,
     turn_complete INTEGER,
     error_code TEXT,
     error_message TEXT,
     interrupted INTEGER,
     input_transcription TEXT,
     output_transcription TEXT,
     PRIMARY KEY (id, app_name, user_id, session_id)
   )`,
];

/** One `events` row, with every column the tests set. */
export interface V0EventRow {
  id: string;
  appName?: string;
  userId?: string;
  sessionId?: string;
  invocationId?: string;
  author?: string;
  actions?: Uint8Array;
  timestamp?: string;
  content?: string;
  longRunningToolIdsJson?: string;
}

/** What a v0 database should hold. Any table left out is not created. */
export interface V0Contents {
  appStates?: Array<{appName: string; state: string}>;
  userStates?: Array<{appName: string; userId: string; state: string}>;
  sessions?: Array<{
    appName: string;
    userId: string;
    id: string;
    state: string;
  }>;
  events?: V0EventRow[];
  /** Tables to leave out entirely, so the migration reports them absent. */
  omitTables?: readonly string[];
}

/** An open connection to a database, for running raw SQL in a test. */
export interface RawDatabase {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

/** Opens a raw connection to a SQLite file. */
export async function openRawDatabase(dbPath: string): Promise<RawDatabase> {
  const orm = await MikroORM.init(
    await getConnectionOptionsFromUri(`sqlite://${dbPath}`),
  );
  const connection = orm.em.getConnection();
  return {
    execute: (sql, params) => connection.execute(sql, params),
    close: () => orm.close(true),
  };
}

/** Creates a v0 database at `dbPath` and fills it with `contents`. */
export async function createV0Database(
  dbPath: string,
  contents: V0Contents = {},
): Promise<void> {
  const omitted = new Set(contents.omitTables ?? []);
  const database = await openRawDatabase(dbPath);
  try {
    for (const statement of V0_DDL) {
      if (!omitted.has(tableNameOf(statement))) {
        await database.execute(statement);
      }
    }
    for (const state of contents.appStates ?? []) {
      await database.execute(
        'INSERT INTO app_states (app_name, state, update_time) VALUES (?, ?, ?)',
        [state.appName, state.state, V0_TIMESTAMP],
      );
    }
    for (const state of contents.userStates ?? []) {
      await database.execute(
        'INSERT INTO user_states (app_name, user_id, state, update_time)' +
          ' VALUES (?, ?, ?, ?)',
        [state.appName, state.userId, state.state, V0_TIMESTAMP],
      );
    }
    for (const session of contents.sessions ?? []) {
      await database.execute(
        'INSERT INTO sessions (app_name, user_id, id, state, create_time,' +
          ' update_time) VALUES (?, ?, ?, ?, ?, ?)',
        [
          session.appName,
          session.userId,
          session.id,
          session.state,
          V0_TIMESTAMP,
          V0_TIMESTAMP,
        ],
      );
    }
    for (const event of contents.events ?? []) {
      await database.execute(
        'INSERT INTO events (id, app_name, user_id, session_id,' +
          ' invocation_id, author, actions, timestamp, content,' +
          ' long_running_tool_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id,
          event.appName ?? 'app1',
          event.userId ?? 'user1',
          event.sessionId ?? 'session1',
          event.invocationId ?? 'invoke1',
          event.author ?? 'user',
          event.actions === undefined ? null : Buffer.from(event.actions),
          event.timestamp ?? V0_TIMESTAMP,
          event.content ?? null,
          event.longRunningToolIdsJson ?? null,
        ],
      );
    }
  } finally {
    await database.close();
  }
}

/** Reads the table a `CREATE TABLE` statement declares. */
function tableNameOf(statement: string): string {
  return statement.slice('CREATE TABLE '.length).split(' ')[0];
}
