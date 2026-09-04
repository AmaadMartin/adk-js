/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds and inspects real sqlite databases in the v0 session layout, so the
 * migration tests run against the same driver stack the service uses.
 */

import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** The v0 tables, exactly as adk-python's `schemas/v0.py` declares them. */
const V0_TABLES: {readonly [table: string]: string} = {
  app_states: `CREATE TABLE app_states (
    app_name VARCHAR(128) NOT NULL PRIMARY KEY,
    state TEXT NOT NULL,
    update_time TIMESTAMP NOT NULL
  )`,
  user_states: `CREATE TABLE user_states (
    app_name VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    state TEXT NOT NULL,
    update_time TIMESTAMP NOT NULL,
    PRIMARY KEY (app_name, user_id)
  )`,
  sessions: `CREATE TABLE sessions (
    app_name VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    state TEXT NOT NULL,
    create_time TIMESTAMP NOT NULL,
    update_time TIMESTAMP NOT NULL,
    PRIMARY KEY (app_name, user_id, id)
  )`,
  events: `CREATE TABLE events (
    id VARCHAR(128) NOT NULL,
    app_name VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(128) NOT NULL,
    invocation_id VARCHAR(256) NOT NULL,
    author VARCHAR(256) NOT NULL,
    actions BLOB NOT NULL,
    long_running_tool_ids_json TEXT,
    branch VARCHAR(256),
    timestamp TIMESTAMP NOT NULL,
    content TEXT,
    grounding_metadata TEXT,
    custom_metadata TEXT,
    usage_metadata TEXT,
    citation_metadata TEXT,
    partial BOOLEAN,
    turn_complete BOOLEAN,
    error_code VARCHAR(256),
    error_message TEXT,
    interrupted BOOLEAN,
    input_transcription TEXT,
    output_transcription TEXT,
    PRIMARY KEY (id, app_name, user_id, session_id)
  )`,
};

/** An open sqlite database a test can write rows into and then read back. */
export class SqliteFixture {
  private constructor(
    readonly path: string,
    private readonly orm: MikroORM,
  ) {}

  /** Opens `path`, creating the file if it does not exist. */
  static async open(path: string): Promise<SqliteFixture> {
    const orm = await MikroORM.init({
      dbName: path,
      driver: SqliteDriver,
      entities: [],
      discovery: {warnWhenNoEntities: false},
      allowGlobalContext: true,
    });
    return new SqliteFixture(path, orm);
  }

  /** The SQLAlchemy-style URL adk-python users hold for this database. */
  get url(): string {
    return sqliteUrl(this.path);
  }

  /** Creates the named v0 tables. Omit `tables` to create all four. */
  async createV0Tables(tables: string[] = Object.keys(V0_TABLES)) {
    for (const table of tables) {
      await this.execute(V0_TABLES[table]);
    }
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    return this.orm.em
      .getConnection()
      .execute<Array<Record<string, unknown>>>(sql, params, 'all');
  }

  /**
   * Inserts one row, naming its columns from `row`.
   *
   * A `Uint8Array` becomes a `Buffer` first: the sqlite driver stringifies
   * anything else bound to a `BLOB` column, which would make a pickled
   * `actions` value unreadable in a way no real database is.
   */
  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(row).map((value) =>
      value instanceof Uint8Array ? Buffer.from(value) : value,
    );
    await this.execute(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
  }

  /** The column names of `table`, in declaration order. */
  async columnsOf(table: string): Promise<string[]> {
    const rows = await this.execute(`PRAGMA table_info(${table})`);
    return rows.map((row) => String(row['name']));
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

/**
 * The connection URL for a sqlite file.
 *
 * A POSIX path already opens with a slash, giving SQLAlchemy's familiar
 * `sqlite:///tmp/x.db`; a Windows path opens with a drive letter and takes
 * only the two slashes of the scheme.
 */
export function sqliteUrl(path: string, scheme = 'sqlite'): string {
  return `${scheme}://${path.startsWith('/') ? '/' : ''}${path}`;
}

/** Returns a fresh temporary directory that the test can put databases in. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'adk-migration-'));
}

/** A path inside `directory` for a database the test has not created yet. */
export function databasePath(directory: string, name: string): string {
  return join(directory, name);
}
