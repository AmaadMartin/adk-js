/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {SessionNotFoundError} from '../errors/session_not_found_error.js';
import {StaleSessionError} from '../errors/stale_session_error.js';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionConfig,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  trimTempDeltaState,
} from './base_session_service.js';
import {CompositeSessionKey, createSession, Session} from './session.js';
import {
  extractJsonSafeStateDelta,
  makeDeltaJsonSafe,
  ScopedStateDelta,
} from './session_state_utils.js';
import {
  isConstraintViolation,
  mergeStateSql,
  SqliteConnection,
  SqliteDatabase,
} from './sqlite_connection.js';
import {State} from './state.js';

/** The parameters for `getUserState`. */
export interface GetUserStateRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
}

/** A row of the `sessions` table, as `listSessions` selects it. */
interface SessionRow {
  id: string;
  user_id: string;
  state: string;
  update_time: number;
}

const APP_STATE_UPSERT = `
    INSERT INTO app_states (app_name, state, update_time) VALUES (?, ?, ?)
    ON CONFLICT(app_name) DO UPDATE SET state=(${mergeStateSql(
      'excluded.state',
      'state',
    )}), update_time=excluded.update_time
    `;

const USER_STATE_UPSERT = `
    INSERT INTO user_states (app_name, user_id, state, update_time) VALUES (?, ?, ?, ?)
    ON CONFLICT(app_name, user_id) DO UPDATE SET state=(${mergeStateSql(
      'excluded.state',
      'state',
    )}), update_time=excluded.update_time
    `;

/** Binds the delta twice: the merge expression reads it in two places. */
const SESSION_STATE_UPDATE =
  `UPDATE sessions SET state=(${mergeStateSql('?', 'state')}),` +
  ' update_time=? WHERE app_name=? AND user_id=? AND id=?';

const STALE_SESSION_MESSAGE =
  'The last_update_time provided in the session object is earlier than the' +
  ' update_time in storage. Please check if it is a stale session.';

/**
 * Converts an adk-js millisecond timestamp to the POSIX seconds the file
 * format stores, so that adk-python reads the same instant back.
 */
function toEpochSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}

/** Converts a stored POSIX-second epoch back to adk-js milliseconds. */
function toMilliseconds(epochSeconds: number): number {
  return Math.round(epochSeconds * 1000);
}

/**
 * Decodes a persisted JSON state column.
 *
 * @param value The raw column text.
 * @param context Names the column in the error message.
 * @return The decoded state.
 * @throws If the text is not JSON, or does not decode to an object.
 */
export function decodeState(
  value: string,
  context = 'persisted state',
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (e: unknown) {
    throw new Error(`Invalid JSON in ${context}: ${formatError(e)}`, {
      cause: e,
    });
  }

  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    throw new Error('Persisted session state must be a JSON object.');
  }

  const state: Record<string, unknown> = Object.create(null);
  return Object.assign(state, decoded);
}

/**
 * Copies the event's `temp:` state onto the in-memory session, so a later
 * agent in the same invocation reads what an earlier one wrote. The keys are
 * trimmed out of the event before it is persisted.
 */
function applyTempState(session: Session, event: Event): void {
  for (const [key, value] of Object.entries(event.actions.stateDelta)) {
    if (key.startsWith(State.TEMP_PREFIX)) {
      session.state[key] = value;
    }
  }
}

/**
 * Runs `work` inside an immediate transaction, rolling back on failure.
 *
 * `IMMEDIATE` takes the write lock up front. A deferred transaction that has
 * already read cannot upgrade to a writer, and SQLite fails it at once
 * instead of letting the busy timeout apply.
 */
async function inTransaction<T>(
  connection: SqliteConnection,
  work: () => Promise<T>,
): Promise<T> {
  await connection.run('BEGIN IMMEDIATE');
  try {
    const result = await work();
    await connection.run('COMMIT');
    return result;
  } catch (e: unknown) {
    await connection.run('ROLLBACK');
    throw e;
  }
}

/** Reads and decodes a JSON state column from a single row. */
async function readState(
  connection: SqliteConnection,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>> {
  const row = await connection.get<{state: string}>(sql, params);
  return row ? decodeState(row.state) : {};
}

function readAppState(
  connection: SqliteConnection,
  appName: string,
): Promise<Record<string, unknown>> {
  return readState(
    connection,
    'SELECT state FROM app_states WHERE app_name=?',
    [appName],
  );
}

function readUserState(
  connection: SqliteConnection,
  appName: string,
  userId: string,
): Promise<Record<string, unknown>> {
  return readState(
    connection,
    'SELECT state FROM user_states WHERE app_name=? AND user_id=?',
    [appName, userId],
  );
}

/** Reads the user states `listSessions` needs, keyed by user id. */
async function readUserStates(
  connection: SqliteConnection,
  appName: string,
  userId?: string,
): Promise<Record<string, Record<string, unknown>>> {
  const states: Record<string, Record<string, unknown>> = Object.create(null);
  if (userId) {
    const state = await readUserState(connection, appName, userId);
    if (Object.keys(state).length > 0) {
      states[userId] = state;
    }
    return states;
  }
  const rows = await connection.all<{user_id: string; state: string}>(
    'SELECT user_id, state FROM user_states WHERE app_name=?',
    [appName],
  );
  for (const row of rows) {
    states[row.user_id] = decodeState(row.state, 'user state');
  }
  return states;
}

function upsertAppState(
  connection: SqliteConnection,
  appName: string,
  delta: Record<string, unknown>,
  updateTime: number,
): Promise<void> {
  return connection.run(APP_STATE_UPSERT, [
    appName,
    JSON.stringify(delta),
    updateTime,
  ]);
}

function upsertUserState(
  connection: SqliteConnection,
  appName: string,
  userId: string,
  delta: Record<string, unknown>,
  updateTime: number,
): Promise<void> {
  return connection.run(USER_STATE_UPSERT, [
    appName,
    userId,
    JSON.stringify(delta),
    updateTime,
  ]);
}

/** Writes the app and user scopes of `delta` that have entries. */
async function upsertSharedStates(
  connection: SqliteConnection,
  key: CompositeSessionKey,
  delta: ScopedStateDelta,
  updateTime: number,
): Promise<void> {
  if (Object.keys(delta.app).length > 0) {
    await upsertAppState(connection, key.appName, delta.app, updateTime);
  }
  if (Object.keys(delta.user).length > 0) {
    await upsertUserState(
      connection,
      key.appName,
      key.userId,
      delta.user,
      updateTime,
    );
  }
}

/** Writes the scopes of `delta` that have entries. Returns whether the
 * session's own state column was written. */
async function writeStateDelta(
  connection: SqliteConnection,
  key: CompositeSessionKey,
  delta: ScopedStateDelta,
  updateTime: number,
): Promise<boolean> {
  await upsertSharedStates(connection, key, delta, updateTime);
  if (Object.keys(delta.session).length === 0) {
    return false;
  }
  const encoded = JSON.stringify(delta.session);
  await connection.run(SESSION_STATE_UPDATE, [
    encoded,
    encoded,
    updateTime,
    key.appName,
    key.userId,
    key.sessionId,
  ]);
  return true;
}

/** Reads a session's events oldest-first, honouring `config`. */
async function readEvents(
  connection: SqliteConnection,
  key: CompositeSessionKey,
  config?: GetSessionConfig,
): Promise<Event[]> {
  if (config?.numRecentEvents === 0) {
    return [];
  }

  const query = [
    'SELECT event_data FROM events',
    'WHERE app_name=? AND user_id=? AND session_id=?',
  ];
  const params: unknown[] = [key.appName, key.userId, key.sessionId];

  if (config?.afterTimestamp) {
    query.push('AND timestamp >= ?');
    params.push(toEpochSeconds(config.afterTimestamp));
  }
  // Tied timestamps need a total order, or a replayed conversation shuffles
  // between reads and `numRecentEvents` truncates at an arbitrary point in
  // the tie.
  query.push('ORDER BY timestamp DESC, id DESC');
  if (config?.numRecentEvents !== undefined) {
    query.push('LIMIT ?');
    params.push(config.numRecentEvents);
  }

  const rows = await connection.all<{event_data: string}>(
    query.join(' '),
    params,
  );
  return rows
    .reverse()
    .map((row) => transformToCamelCaseEvent(JSON.parse(row.event_data)));
}

/**
 * A session service that stores sessions in a SQLite file through the
 * `sqlite3` driver, with no object-relational mapper in between.
 *
 * It owns four hand-written tables, keeps epochs as `REAL` POSIX seconds and
 * events as snake_case JSON text, so the file it writes is the one
 * adk-python's `SqliteSessionService` reads. State merges happen in SQL, so a
 * concurrent writer cannot lose a key to a read-modify-write race.
 *
 * The `sqlite3` package is an optional peer dependency, loaded on first use:
 *
 * ```sh
 * npm install sqlite3
 * ```
 *
 * ```ts
 * import {SqliteSessionService} from '@google/adk';
 *
 * const service = new SqliteSessionService('./.adk/session.db');
 * // SQLAlchemy-style URLs work too:
 * //   sqlite:///relative.db     -> ./relative.db
 * //   sqlite:////var/lib/adk.db -> /var/lib/adk.db
 * const session = await service.createSession({appName: 'app', userId: 'u'});
 * ```
 *
 * A database written by this service is not interchangeable with one written
 * by {@link DatabaseSessionService}: the column types differ and there is no
 * schema-version table. adk-python keeps the same two services apart for the
 * same reason. Pick one and stay with it for a given file.
 */
export class SqliteSessionService extends BaseSessionService {
  private readonly database: SqliteDatabase;

  /**
   * @param dbPath A filesystem path to the database file, or a SQLAlchemy
   *   style `sqlite:` / `sqlite+aiosqlite:` URL.
   */
  constructor(dbPath: string) {
    super();
    this.database = new SqliteDatabase(dbPath);
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const id = sessionId?.trim() || randomUUID();
    const now = Date.now();
    const updateTime = toEpochSeconds(now);

    return this.withConnection(async (connection) => {
      const existing = await connection.get<{found: number}>(
        'SELECT 1 AS found FROM sessions WHERE app_name=? AND user_id=? AND id=?',
        [appName, userId, id],
      );
      if (existing) {
        throw new AlreadyExistsError(`Session with id ${id} already exists.`);
      }

      const deltas = extractJsonSafeStateDelta(state ?? {});
      const [appState, userState] = await inTransaction(connection, () =>
        this.insertSession(
          connection,
          {appName, userId, sessionId: id},
          deltas,
          updateTime,
        ),
      );

      return createSession({
        id,
        appName,
        userId,
        state: mergeStates(appState, userState, deltas.session),
        events: [],
        lastUpdateTime: now,
      });
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    return this.withConnection(async (connection) => {
      const row = await connection.get<{state: string; update_time: number}>(
        'SELECT state, update_time FROM sessions WHERE app_name=? AND user_id=? AND id=?',
        [appName, userId, sessionId],
      );
      if (!row) {
        return undefined;
      }

      const sessionState = decodeState(row.state, 'session state');
      const events = await readEvents(
        connection,
        {appName, userId, sessionId},
        config,
      );
      const appState = await readAppState(connection, appName);
      const userState = await readUserState(connection, appName, userId);

      return createSession({
        id: sessionId,
        appName,
        userId,
        state: mergeStates(appState, userState, sessionState),
        events,
        lastUpdateTime: toMilliseconds(row.update_time),
      });
    });
  }

  /**
   * Lists an app's sessions, oldest active first.
   *
   * The whole result set comes back as one page. The reference implementation
   * has no pagination, so the `limit`, `offset`, `page` and `order` fields of
   * {@link ListSessionsRequest} are not honoured here; reach for
   * {@link DatabaseSessionService} when a caller needs them.
   */
  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.withConnection(async (connection) => {
      const rows = userId
        ? await connection.all<SessionRow>(
            'SELECT id, user_id, state, update_time FROM sessions WHERE app_name=? AND user_id=? ORDER BY update_time, user_id, id',
            [appName, userId],
          )
        : await connection.all<SessionRow>(
            'SELECT id, user_id, state, update_time FROM sessions WHERE app_name=? ORDER BY update_time, user_id, id',
            [appName],
          );

      const appState = await readAppState(connection, appName);
      const userStates = await readUserStates(connection, appName, userId);

      const sessions = rows.map((row) =>
        createSession({
          id: row.id,
          appName,
          userId: row.user_id,
          state: mergeStates(
            appState,
            userStates[row.user_id] ?? {},
            decodeState(row.state, 'session state'),
          ),
          events: [],
          lastUpdateTime: toMilliseconds(row.update_time),
        }),
      );

      const totalItems = sessions.length;
      return {
        sessions,
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    });
  }

  /**
   * Deletes a session. Its events go with it, through the foreign key's
   * `ON DELETE CASCADE`.
   */
  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    await this.withConnection((connection) =>
      connection.run(
        'DELETE FROM sessions WHERE app_name=? AND user_id=? AND id=?',
        [appName, userId, sessionId],
      ),
    );
  }

  /**
   * Reads a user's `user:`-scoped state, with the prefix stripped.
   *
   * @param request The app and user to read.
   * @return The stored user state, empty when the user has none.
   */
  async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    return this.withConnection((connection) =>
      readUserState(connection, appName, userId),
    );
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    applyTempState(session, event);
    event = trimTempDeltaState(event);
    makeDeltaJsonSafe(event);

    const key: CompositeSessionKey = {
      appName: session.appName,
      userId: session.userId,
      sessionId: session.id,
    };
    const timestamp = event.timestamp;
    const updateTime = toEpochSeconds(timestamp);

    await this.withConnection((connection) =>
      inTransaction(connection, () =>
        this.insertEvent(connection, session, event, key, updateTime),
      ),
    );

    session.lastUpdateTime = timestamp;
    return super.appendEvent({session, event});
  }

  /** Writes the initial state and the session row. Returns the stored app and
   * user state the new session's merged view is built from. */
  private async insertSession(
    connection: SqliteConnection,
    key: CompositeSessionKey,
    deltas: ScopedStateDelta,
    updateTime: number,
  ): Promise<[Record<string, unknown>, Record<string, unknown>]> {
    await upsertSharedStates(connection, key, deltas, updateTime);

    const appState = await readAppState(connection, key.appName);
    const userState = await readUserState(connection, key.appName, key.userId);

    try {
      await connection.run(
        'INSERT INTO sessions (app_name, user_id, id, state, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?)',
        [
          key.appName,
          key.userId,
          key.sessionId,
          JSON.stringify(deltas.session),
          updateTime,
          updateTime,
        ],
      );
    } catch (e: unknown) {
      // A concurrent caller won the race between the existence probe above
      // and this insert.
      if (isConstraintViolation(e)) {
        throw new AlreadyExistsError(
          `Session with id ${key.sessionId} already exists.`,
        );
      }
      throw e;
    }

    return [appState, userState];
  }

  /** Applies the event's state delta and appends the event row. */
  private async insertEvent(
    connection: SqliteConnection,
    session: Session,
    event: Event,
    key: CompositeSessionKey,
    updateTime: number,
  ): Promise<void> {
    const stored = await connection.get<{update_time: number}>(
      'SELECT update_time FROM sessions WHERE app_name=? AND user_id=? AND id=?',
      [key.appName, key.userId, key.sessionId],
    );
    if (!stored) {
      throw new SessionNotFoundError(`Session ${session.id} not found.`);
    }
    if (toMilliseconds(stored.update_time) > session.lastUpdateTime) {
      throw new StaleSessionError(STALE_SESSION_MESSAGE);
    }

    const stateDelta = event.actions.stateDelta;
    const sessionStateWritten =
      Object.keys(stateDelta).length > 0
        ? await writeStateDelta(
            connection,
            key,
            extractJsonSafeStateDelta(stateDelta),
            updateTime,
          )
        : false;

    await connection.run(
      'INSERT INTO events (id, app_name, user_id, session_id, invocation_id, timestamp, event_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        event.id,
        key.appName,
        key.userId,
        key.sessionId,
        event.invocationId,
        updateTime,
        JSON.stringify(transformToSnakeCaseEvent(event)),
      ],
    );

    if (!sessionStateWritten) {
      await connection.run(
        'UPDATE sessions SET update_time=? WHERE app_name=? AND user_id=? AND id=?',
        [updateTime, key.appName, key.userId, key.sessionId],
      );
    }
  }

  /** Opens a connection for one operation and closes it on every path. */
  private async withConnection<T>(
    work: (connection: SqliteConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.database.connect();
    try {
      return await work(connection);
    } finally {
      await connection.close();
    }
  }
}
