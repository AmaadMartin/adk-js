/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync} from 'node:fs';

import type {Database} from 'sqlite3';

import {loadOptionalPeer} from '../utils/optional_peer.js';

/** The `sqlite3` module namespace, referenced without importing its value. */
type Sqlite3Module = typeof import('sqlite3');

/**
 * SQLite reads `foreign_keys` per connection and defaults it off, so the
 * `ON DELETE CASCADE` on `events` only fires when every connection sets it.
 */
const PRAGMA_FOREIGN_KEYS = 'PRAGMA foreign_keys = ON';

/**
 * How long a connection waits for another writer to release the database
 * lock. The reference implementation inherits five seconds from Python's
 * `sqlite3` module; without it a second writer fails immediately with
 * `SQLITE_BUSY` instead of taking its turn.
 */
const BUSY_TIMEOUT_MS = 5000;

/** SQLite's result code for a violated primary key or other constraint. */
const SQLITE_CONSTRAINT = 'SQLITE_CONSTRAINT';

/** The driver package, and the feature its missing-package error names. */
export const SQLITE3_PEER = {
  packageName: 'sqlite3',
  feature: 'SqliteSessionService',
};

/**
 * Splits a SQLAlchemy-style SQLite URL into its path and query.
 *
 * The optional `//authority` is matched and discarded, so `sqlite:///rel.db`
 * yields the path `/rel.db`. `URL` is deliberately not used here: it resolves
 * `.` and `..` segments, which would retarget `sqlite:///../shared.db` at the
 * working directory.
 */
const SQLITE_URL =
  /^sqlite(?:\+aiosqlite)?:(?:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?$/;

/** A SQLite database file, in the several forms its callers need. */
export interface SqliteDbPath {
  /** Filesystem path, for existence checks and user-facing messages. */
  filePath: string;
  /** The value handed to the driver's `Database` constructor. */
  connectPath: string;
  /** Whether `connectPath` is a `file:` URI and needs `OPEN_URI`. */
  useUri: boolean;
}

/**
 * Normalizes a SQLite database path given as a filesystem path or as a
 * SQLAlchemy-style URL.
 *
 * A string that is not a SQLite URL is returned unchanged. Otherwise the URL
 * follows SQLAlchemy's conventions: `sqlite:///relative.db` is relative to the
 * working directory and `sqlite:////absolute.db` is an absolute path.
 *
 * @param dbPath A filesystem path, or a `sqlite:` / `sqlite+aiosqlite:` URL.
 * @return The path to open, and whether it is a URI.
 */
export function parseSqliteDbPath(dbPath: string): SqliteDbPath {
  const match = SQLITE_URL.exec(dbPath);
  if (match === null) {
    return {filePath: dbPath, connectPath: dbPath, useUri: false};
  }

  const rawPath = decodeURIComponent(match[1]);
  if (!rawPath) {
    return {filePath: dbPath, connectPath: dbPath, useUri: false};
  }

  const filePath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const query = match[2];
  if (query) {
    // SQLite only reads a filename as a URI when it starts with `file:`.
    return {filePath, connectPath: `file:${filePath}?${query}`, useUri: true};
  }
  return {filePath, connectPath: filePath, useUri: false};
}

/**
 * Returns whether `e` is the driver reporting a violated constraint, which is
 * how a caller-supplied session id that another writer already inserted
 * surfaces.
 */
export function isConstraintViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as Error & {code?: string}).code === SQLITE_CONSTRAINT
  );
}

/**
 * Builds the expression that merges the JSON object `delta` into the JSON
 * object `state` with `Object.assign` semantics: a key in the delta wins with
 * its delta value, JSON `null` included.
 *
 * `json_patch()` cannot be used in its place. It deep-merges object values
 * instead of replacing them, and it reads `null` as "delete this key".
 *
 * @param delta SQL expression yielding the delta object. Never caller input.
 * @param state SQL expression yielding the stored object. Never caller input.
 * @return The merge expression, which reads `delta` twice.
 */
export function mergeStateSql(delta: string, state: string): string {
  return `
        SELECT json_group_object(
                 key,
                 CASE
                   WHEN type IN ('object','array') THEN json(value)
                   WHEN type IN ('true','false') THEN json(type)
                   ELSE value
                 END)
        FROM (
          SELECT key, value, type FROM json_each(${delta})
          UNION ALL
          SELECT key, value, type FROM json_each(${state})
           WHERE key NOT IN (SELECT key FROM json_each(${delta}))
        )
      `;
}

/**
 * The four tables the service owns.
 *
 * The epoch columns are `REAL` POSIX seconds and the state columns are JSON
 * text, matching the file layout adk-python's `SqliteSessionService` writes.
 */
export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_states (
    app_name TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    update_time REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS user_states (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL,
    update_time REAL NOT NULL,
    PRIMARY KEY (app_name, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    state TEXT NOT NULL,
    create_time REAL NOT NULL,
    update_time REAL NOT NULL,
    PRIMARY KEY (app_name, user_id, id)
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    event_data TEXT NOT NULL,
    PRIMARY KEY (app_name, user_id, session_id, id),
    FOREIGN KEY (app_name, user_id, session_id) REFERENCES sessions(app_name, user_id, id) ON DELETE CASCADE
);
`;

/** Builds the message that tells a caller how to migrate a legacy database. */
function legacySchemaMessage(filePath: string): string {
  return (
    `Database ${filePath} seems to use an old schema.` +
    ' Please run the migration command to' +
    ' migrate it to the new schema. Example: `python -m' +
    ' google.adk.sessions.migration.migrate_from_sqlalchemy_sqlite' +
    ` --source_db_path ${filePath} --dest_db_path` +
    ` ${filePath}.new` +
    `\` then backup ${filePath} and rename` +
    ` ${filePath}.new to ${filePath}.`
  );
}

/**
 * One open connection to a SQLite database, with its callback API promisified.
 *
 * The caller owns the connection and must {@link close} it on every path.
 */
export class SqliteConnection {
  private constructor(private readonly db: Database) {}

  /**
   * Opens a connection and gives it the shared busy timeout.
   *
   * @param driver The loaded `sqlite3` module.
   * @param path The database to open.
   * @return The open connection.
   */
  static open(
    driver: Sqlite3Module,
    path: SqliteDbPath,
  ): Promise<SqliteConnection> {
    const mode =
      driver.OPEN_READWRITE |
      driver.OPEN_CREATE |
      (path.useUri ? driver.OPEN_URI : 0);
    return new Promise((resolve, reject) => {
      const db = new driver.Database(path.connectPath, mode, (err) => {
        if (err) {
          reject(err);
          return;
        }
        db.configure('busyTimeout', BUSY_TIMEOUT_MS);
        resolve(new SqliteConnection(db));
      });
    });
  }

  /** Runs a statement that returns no rows. */
  run(sql: string, params: readonly unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /** Runs a script of several statements. */
  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /** Returns the first row of a query, or `undefined` when there is none. */
  get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<T | undefined>(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      });
    });
  }

  /** Returns every row of a query. */
  all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all<T>(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  /** Releases the handle. A Node process does not exit while one is open. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

/** Returns whether `events` exists and predates the `event_data` column. */
async function hasLegacySchema(connection: SqliteConnection): Promise<boolean> {
  const eventsTable = await connection.get<{found: number}>(
    "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='events'",
  );
  if (!eventsTable) {
    return false;
  }
  const columns = await connection.all<{name: string}>(
    'PRAGMA table_info(events)',
  );
  return !columns.some((column) => column.name === 'event_data');
}

/**
 * Opens connections to one SQLite database file.
 *
 * A connection is opened per operation, as the reference implementation does,
 * so that two concurrent writers contend in SQLite rather than interleaving
 * their transactions on one handle. Loading the driver, refusing a legacy
 * database and creating the schema are one-time costs, so they live here
 * instead of on the connections this hands out.
 */
export class SqliteDatabase {
  private readonly path: SqliteDbPath;
  private driver?: Sqlite3Module;
  private schemaReady = false;
  private schemaChecked = false;

  constructor(dbPath: string) {
    this.path = parseSqliteDbPath(dbPath);
  }

  /** The filesystem path of the database file. */
  get filePath(): string {
    return this.path.filePath;
  }

  /**
   * Opens a connection with foreign keys on and the schema in place.
   *
   * @return An open connection the caller must close.
   * @throws If the database still uses the pre-`event_data` schema, or if the
   *   `sqlite3` package is not installed.
   */
  async connect(): Promise<SqliteConnection> {
    const driver = await this.loadDriver();
    await this.rejectLegacySchema(driver);

    const connection = await SqliteConnection.open(driver, this.path);
    try {
      await connection.run(PRAGMA_FOREIGN_KEYS);
      if (!this.schemaReady) {
        await connection.exec(CREATE_SCHEMA_SQL);
        this.schemaReady = true;
      }
    } catch (e: unknown) {
      await connection.close();
      throw e;
    }
    return connection;
  }

  private async loadDriver(): Promise<Sqlite3Module> {
    if (this.driver === undefined) {
      // node-sqlite3 is CommonJS, so its exports arrive under `default`, as
      // Express's do in `a2a/agent_to_a2a.ts`. Its type declarations describe
      // the flat shape instead, so the namespace is annotated here.
      const mod = await loadOptionalPeer(
        SQLITE3_PEER,
        (): Promise<{default: Sqlite3Module}> => import('sqlite3'),
      );
      this.driver = mod.default;
    }
    return this.driver;
  }

  /**
   * Refuses a database written by a version that stored event columns rather
   * than an `event_data` JSON column.
   *
   * The reference runs this check in its constructor. node-sqlite3 is
   * callback-based, so it runs here instead, before the first connection is
   * used; a caller still cannot read or write a legacy database.
   */
  private async rejectLegacySchema(driver: Sqlite3Module): Promise<void> {
    if (this.schemaChecked) {
      return;
    }
    if (!existsSync(this.path.filePath)) {
      this.schemaChecked = true;
      return;
    }
    const connection = await SqliteConnection.open(driver, this.path);
    let legacy: boolean;
    try {
      legacy = await hasLegacySchema(connection);
    } finally {
      await connection.close();
    }
    if (legacy) {
      throw new Error(legacySchemaMessage(this.path.filePath));
    }
    this.schemaChecked = true;
  }
}
