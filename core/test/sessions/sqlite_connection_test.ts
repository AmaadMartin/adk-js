/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sqlite3 from 'sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  isConstraintViolation,
  mergeStateSql,
  parseSqliteDbPath,
  SqliteDatabase,
} from '../../src/sessions/sqlite_connection.js';

/** Runs one statement against a bare driver handle and closes it. */
function execRaw(dbPath: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.exec(sql, (execError) => {
        db.close(() => {
          if (execError) {
            reject(execError);
            return;
          }
          resolve();
        });
      });
    });
  });
}

describe('parseSqliteDbPath', () => {
  it.each([
    ['./session.db', './session.db', './session.db', false],
    ['/var/lib/adk.db', '/var/lib/adk.db', '/var/lib/adk.db', false],
    ['sqlite:///relative.db', 'relative.db', 'relative.db', false],
    ['sqlite:////var/lib/adk.db', '/var/lib/adk.db', '/var/lib/adk.db', false],
    ['sqlite+aiosqlite:///relative.db', 'relative.db', 'relative.db', false],
    ['sqlite+aiosqlite:///x.db?mode=ro', 'x.db', 'file:x.db?mode=ro', true],
    ['sqlite://', 'sqlite://', 'sqlite://', false],
    // The opaque form carries no authority and no leading slash to strip.
    ['sqlite:opaque.db', 'opaque.db', 'opaque.db', false],
    // A Windows absolute path takes three slashes, not four, because the
    // drive letter stands where the leading slash would.
    [
      'sqlite:///C:\\Users\\a\\adk.db',
      'C:\\Users\\a\\adk.db',
      'C:\\Users\\a\\adk.db',
      false,
    ],
  ])('parses %s', (input, filePath, connectPath, useUri) => {
    expect(parseSqliteDbPath(input)).toEqual({
      filePath,
      connectPath,
      useUri,
    });
  });

  it('percent-decodes the path', () => {
    expect(parseSqliteDbPath('sqlite:///my%20db.db').filePath).toBe('my db.db');
  });

  it('keeps a relative path that walks up out of the working directory', () => {
    // `URL` would resolve the `..` away and silently open a different file.
    expect(parseSqliteDbPath('sqlite:///../shared.db').filePath).toBe(
      '../shared.db',
    );
  });

  it('returns a scheme with no path unchanged', () => {
    expect(parseSqliteDbPath('sqlite:')).toEqual({
      filePath: 'sqlite:',
      connectPath: 'sqlite:',
      useUri: false,
    });
  });

  it('leaves a lookalike scheme alone', () => {
    expect(parseSqliteDbPath('sqlite3:///x.db').filePath).toBe(
      'sqlite3:///x.db',
    );
    expect(parseSqliteDbPath('postgres://host/db').filePath).toBe(
      'postgres://host/db',
    );
  });
});

describe('mergeStateSql', () => {
  it('reads the delta expression twice and the state expression once', () => {
    const sql = mergeStateSql('excluded.state', 'state');
    expect(sql.match(/json_each\(excluded\.state\)/g)).toHaveLength(2);
    expect(sql.match(/json_each\(state\)/g)).toHaveLength(1);
  });
});

describe('isConstraintViolation', () => {
  it('recognises the driver constraint error', () => {
    const error = Object.assign(new Error('constraint failed'), {
      code: 'SQLITE_CONSTRAINT',
    });
    expect(isConstraintViolation(error)).toBe(true);
  });

  it('rejects another driver error and a non-error', () => {
    const busy = Object.assign(new Error('busy'), {code: 'SQLITE_BUSY'});
    expect(isConstraintViolation(busy)).toBe(false);
    expect(isConstraintViolation(new Error('plain'))).toBe(false);
    expect(isConstraintViolation('SQLITE_CONSTRAINT')).toBe(false);
  });
});

describe('SqliteDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-sqlite-connection-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('reports the filesystem path behind a URL', () => {
    expect(new SqliteDatabase('sqlite:////var/lib/adk.db').filePath).toBe(
      '/var/lib/adk.db',
    );
  });

  it('opens a database file that does not exist yet', async () => {
    const database = new SqliteDatabase(join(dir, 'fresh.db'));
    const connection = await database.connect();
    const row = await connection.get<{found: number}>(
      "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='events'",
    );
    await connection.close();
    expect(row).toEqual({found: 1});
  });

  it('opens a file that holds no events table', async () => {
    const dbPath = join(dir, 'unrelated.db');
    await execRaw(dbPath, 'CREATE TABLE notes (id INTEGER)');

    const connection = await new SqliteDatabase(dbPath).connect();
    const row = await connection.get<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notes'",
    );
    await connection.close();
    expect(row).toEqual({name: 'notes'});
  });

  it('opens a file already on the current schema', async () => {
    const dbPath = join(dir, 'current.db');
    const first = new SqliteDatabase(dbPath);
    await (await first.connect()).close();

    const connection = await new SqliteDatabase(dbPath).connect();
    const columns = await connection.all<{name: string}>(
      'PRAGMA table_info(events)',
    );
    await connection.close();
    expect(columns.map((column) => column.name)).toContain('event_data');
  });

  it('refuses a database whose events table predates event_data', async () => {
    const dbPath = join(dir, 'legacy.db');
    await execRaw(
      dbPath,
      'CREATE TABLE events (id TEXT, app_name TEXT, content TEXT)',
    );

    const database = new SqliteDatabase(dbPath);
    await expect(database.connect()).rejects.toThrow(
      /seems to use an old schema/,
    );
    await expect(database.connect()).rejects.toThrow(
      /migrate_from_sqlalchemy_sqlite/,
    );
  });

  it('creates the schema once and keeps serving connections', async () => {
    const database = new SqliteDatabase(join(dir, 'reuse.db'));
    const first = await database.connect();
    await first.run('INSERT INTO app_states VALUES (?, ?, ?)', [
      'app',
      '{"k":1}',
      1,
    ]);
    await first.close();

    const second = await database.connect();
    const row = await second.get<{state: string}>(
      'SELECT state FROM app_states WHERE app_name=?',
      ['app'],
    );
    await second.close();
    expect(row?.state).toBe('{"k":1}');
  });

  it('turns foreign keys on for every connection', async () => {
    const database = new SqliteDatabase(join(dir, 'pragma.db'));
    const connection = await database.connect();
    const row = await connection.get<{foreign_keys: number}>(
      'PRAGMA foreign_keys',
    );
    await connection.close();
    expect(row).toEqual({foreign_keys: 1});
  });

  it('rejects when the database file cannot be opened', async () => {
    const database = new SqliteDatabase(join(dir, 'missing-dir', 'x.db'));
    await expect(database.connect()).rejects.toThrow(/SQLITE_CANTOPEN/);
  });

  it('rejects a failing query rather than resolving with no rows', async () => {
    const connection = await new SqliteDatabase(
      join(dir, 'bad-sql.db'),
    ).connect();
    try {
      await expect(connection.get('SELECT * FROM absent')).rejects.toThrow(
        /no such table: absent/,
      );
      await expect(connection.all('SELECT * FROM absent')).rejects.toThrow(
        /no such table: absent/,
      );
      await expect(
        connection.run('INSERT INTO absent VALUES (1)'),
      ).rejects.toThrow(/no such table: absent/);
    } finally {
      await connection.close();
    }
  });

  it('rejects a second close of the same handle', async () => {
    const connection = await new SqliteDatabase(
      join(dir, 'double.db'),
    ).connect();
    await connection.close();
    await expect(connection.close()).rejects.toThrow(/Database (is|handle is)/);
  });

  it('closes the handle when schema creation fails', async () => {
    // A relative name keeps the URI free of a drive letter and backslashes.
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await execRaw('readonly.db', 'CREATE TABLE t (id INTEGER)');

      const database = new SqliteDatabase('sqlite:///readonly.db?mode=ro');
      await expect(database.connect()).rejects.toThrow(/readonly/);

      // The failed attempt must not leave the file locked for the next writer.
      const connection = await new SqliteDatabase('readonly.db').connect();
      await connection.run('INSERT INTO t VALUES (1)');
      await connection.close();
    } finally {
      process.chdir(previous);
    }
  });
});
