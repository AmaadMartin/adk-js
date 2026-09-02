/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityManager,
  FilterQuery,
  LockMode,
  Options as MikroDBOptions,
  MikroORM,
} from '@mikro-orm/core';

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {SessionNotFoundError} from '../errors/session_not_found_error.js';
import {StaleSessionError} from '../errors/stale_session_error.js';
import {Event} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {KeyedMutex} from '../utils/keyed_mutex.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {
  AppendEventRequest,
  applyTempState,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  extractStateDelta,
  GetSessionRequest,
  GetUserStateRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  ScopedStateDelta,
  trimTempDeltaState,
} from './base_session_service.js';
import {
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  validateDatabaseSchemaVersion,
} from './db/operations.js';
import {
  ENTITIES,
  SCHEMA_VERSION_0_PICKLE,
  StorageAppState,
  StorageEvent,
  StorageSession,
  StorageUserState,
} from './db/schema.js';
import {createSession, Session} from './session.js';

/**
 * The message a stale write is rejected with. The wording matches adk-python,
 * because it reaches the user and both SDKs are tested against it.
 */
const STALE_SESSION_ERROR_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/** Newest event first, with the id breaking a timestamp tie. */
const NEWEST_EVENT_FIRST = {timestamp: 'DESC', id: 'DESC'} as const;

/**
 * Checks if a URI is a database connection URI.
 *
 * @param uri The URI to check.
 * @returns True if the URI is a database connection URI, false otherwise.
 */
export function isDatabaseConnectionString(uri?: string): boolean {
  if (!uri) {
    return false;
  }

  return (
    uri.startsWith('postgres://') ||
    uri.startsWith('postgresql://') ||
    uri.startsWith('mysql://') ||
    uri.startsWith('mariadb://') ||
    uri.startsWith('mssql://') ||
    uri.startsWith('sqlite://')
  );
}

/** Narrows a constructor argument to an already-built MikroORM instance. */
function isMikroORM(source: MikroDBOptions | MikroORM): source is MikroORM {
  return 'em' in source && 'schema' in source && 'close' in source;
}

/** The exact storage revision a session row is currently at. */
function updateMarkerOf(storageSession: StorageSession): string {
  return storageSession.updateTime.toISOString();
}

/**
 * Reads a session row back after a write, and reports the revision it reached.
 *
 * The marker is compared for exact equality against the marker rebuilt on the
 * next append, so it has to describe what the column holds rather than what
 * the caller wrote. A database created before the timestamp columns declared
 * millisecond precision rounds `update_time` to the whole second, and a marker
 * taken from the in-memory value would then never match the row again. Reading
 * inside the write transaction is safe: no other writer can reach the row.
 */
async function readRevision(
  em: EntityManager,
  storageSession: StorageSession,
): Promise<{lastUpdateTime: number; marker: string}> {
  await em.flush();
  const stored = (await em.refresh(storageSession)) ?? storageSession;
  return {
    lastUpdateTime: stored.updateTime.getTime(),
    marker: updateMarkerOf(stored),
  };
}

/** Read options that take a row-level write lock when `enabled`. */
function writeLock(enabled: boolean): {lockMode?: LockMode} {
  return enabled ? {lockMode: LockMode.PESSIMISTIC_WRITE} : {};
}

/** Merges a scoped delta into a stored state row, if it has any entries. */
function applyScopedDelta(
  row: {state: Record<string, unknown>},
  delta: Record<string, unknown>,
): void {
  if (Object.keys(delta).length > 0) {
    row.state = {...row.state, ...delta};
  }
}

/**
 * Reports whether a marker-less session still matches the stored history.
 *
 * A session built by hand carries no revision marker, so the newest stored
 * event stands in for one: the caller is current when it holds that event, or
 * when both it and storage hold none.
 */
async function sessionMatchesStorageRevision(
  em: EntityManager,
  session: Session,
): Promise<boolean> {
  const newestStored = await em.findOne(
    StorageEvent,
    {appName: session.appName, userId: session.userId, sessionId: session.id},
    {orderBy: NEWEST_EVENT_FIRST},
  );
  return newestStored?.id === session.events.at(-1)?.id;
}

/**
 * A session service that uses a SQL database for storage via MikroORM.
 */
export class DatabaseSessionService extends BaseSessionService {
  private orm?: MikroORM;
  private initialized = false;
  private initInFlight?: Promise<void>;
  private options?: MikroDBOptions;
  private connectionString?: string;
  private optionOverrides?: Partial<MikroDBOptions>;
  private readonly ownsOrm: boolean;
  private readonly sessionLocks = new KeyedMutex();

  /**
   * @param source A connection string, a MikroORM options object, or a
   *     MikroORM instance the caller already initialized and continues to own.
   * @param overrides Options merged over the ones derived from a connection
   *     string. Ignored for the other two forms.
   * @throws Error if the connection string is not one this service supports.
   */
  constructor(
    source: MikroDBOptions | MikroORM | string,
    overrides?: Partial<MikroDBOptions>,
  ) {
    super();
    if (typeof source === 'string') {
      if (!isDatabaseConnectionString(source)) {
        throw new Error(
          `Unsupported database URI: ${redactUriPassword(source)}`,
        );
      }
      this.connectionString = source;
      this.optionOverrides = overrides;
      this.ownsOrm = true;
      return;
    }

    if (isMikroORM(source)) {
      this.orm = source;
      this.ownsOrm = false;
      return;
    }

    if (!source.driver) {
      throw new Error('Driver is required when passing options object.');
    }
    this.options = {...source, entities: ENTITIES};
    this.ownsOrm = true;
  }

  /**
   * Connects to the database and prepares its tables.
   *
   * Callers do not need this: every method initializes on demand. Call it
   * during startup to pay the cost upfront. It is safe to call more than once
   * and safe to call concurrently, and a failed attempt can be retried.
   *
   * @throws Error if the database holds the legacy v0 session schema.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initInFlight ??= this.connect().finally(() => {
      this.initInFlight = undefined;
    });
    return this.initInFlight;
  }

  private async connect(): Promise<void> {
    // Hold the instance locally: a `close()` that lands while this is in
    // flight clears the field, and the rest of the method would then run
    // against nothing.
    const orm = (this.orm ??= await MikroORM.init(await this.resolveOptions()));

    // Detect before creating anything: `ensureDatabaseCreated` adds the v1
    // `event_data` column to a legacy `events` table, which erases the
    // evidence the detection reads.
    const version = await detectDatabaseSchemaVersion(orm);
    if (version === SCHEMA_VERSION_0_PICKLE) {
      throw new Error(
        'This database uses the legacy v0 session schema, which stores event ' +
          'actions as a Python pickle that this SDK cannot read. Migrate it ' +
          'with the adk-python `adk migrate session` command first.',
      );
    }

    await ensureDatabaseCreated(orm);
    await validateDatabaseSchemaVersion(orm);
    this.initialized = true;
  }

  private async resolveOptions(): Promise<MikroDBOptions> {
    return this.connectionString === undefined
      ? this.options!
      : getConnectionOptionsFromUri(
          this.connectionString,
          this.optionOverrides,
        );
  }

  /**
   * Releases the database connections this service opened.
   *
   * A MikroORM instance supplied by the caller stays open, because the caller
   * owns it. Calling this twice, or before `init`, does nothing.
   */
  async close(): Promise<void> {
    this.initialized = false;
    if (!this.ownsOrm) {
      return;
    }
    const orm = this.orm;
    this.orm = undefined;
    await orm?.close();
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    await this.init();
    const em = this.orm!.em.fork();

    const id = sessionId || randomUUID();
    const now = new Date();
    if (sessionId && (await this.sessionExists({appName, userId, id}))) {
      throw new AlreadyExistsError(`Session with id ${id} already exists.`);
    }

    let appStateModel = await em.findOne(StorageAppState, {appName});
    if (!appStateModel) {
      appStateModel = em.create(StorageAppState, {
        appName,
        state: {},
        updateTime: now,
      });
      em.persist(appStateModel);
    }

    let userStateModel = await em.findOne(StorageUserState, {appName, userId});
    if (!userStateModel) {
      userStateModel = em.create(StorageUserState, {
        appName,
        userId,
        state: {},
      });
      em.persist(userStateModel);
    }

    const delta = extractStateDelta(state ?? {});
    applyScopedDelta(appStateModel, delta.app);
    applyScopedDelta(userStateModel, delta.user);

    const storageSession = em.create(StorageSession, {
      id,
      appName,
      userId,
      state: delta.session,
      createTime: now,
      updateTime: now,
    });
    em.persist(storageSession);

    let revision: {lastUpdateTime: number; marker: string};
    try {
      revision = await readRevision(em, storageSession);
    } catch (error: unknown) {
      // A concurrent createSession can commit this id between the probe above
      // and this write. Drivers report that as a unique-constraint violation
      // whose class differs per dialect, so the row itself is the evidence.
      if (await this.sessionExists({appName, userId, id})) {
        throw new AlreadyExistsError(`Session with id ${id} already exists.`);
      }
      throw error;
    }

    const mergedState = mergeStates(
      appStateModel.state,
      userStateModel.state,
      delta.session,
    );

    return createSession({
      id,
      appName,
      userId,
      state: mergedState,
      events: [],
      lastUpdateTime: revision.lastUpdateTime,
      storageUpdateMarker: revision.marker,
    });
  }

  private async sessionExists(key: {
    appName: string;
    userId: string;
    id: string;
  }): Promise<boolean> {
    return (await this.orm!.em.fork().count(StorageSession, key)) > 0;
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    await this.init();
    const em = this.orm!.em.fork();

    const storageSession = await em.findOne(StorageSession, {
      appName,
      userId,
      id: sessionId,
    });

    if (!storageSession) {
      return undefined;
    }

    const eventWhere: FilterQuery<StorageEvent> = {
      appName,
      userId,
      sessionId,
    };

    if (config?.afterTimestamp) {
      eventWhere.timestamp = {$gt: new Date(config.afterTimestamp)};
    }

    // Get latest numRecentEvents events or all events in DESC order. The id
    // breaks timestamp ties, matching the ordering the staleness check uses:
    // without it the database may return tied events in a different order on
    // every read, so a replayed conversation shuffles and `numRecentEvents`
    // truncates at an arbitrary point inside the tie.
    const storageEvents = await em.find(StorageEvent, eventWhere, {
      orderBy: NEWEST_EVENT_FIRST,
      limit: config?.numRecentEvents,
    });
    // Reverse the events to maintain the original order as we get events in DESC order
    // to get the latest events first.
    storageEvents.reverse();

    const appStateModel = await em.findOne(StorageAppState, {appName});
    const userStateModel = await em.findOne(StorageUserState, {
      appName,
      userId,
    });

    const mergedState = mergeStates(
      appStateModel?.state || {},
      userStateModel?.state || {},
      storageSession.state,
    );

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergedState,
      events: storageEvents.map((se) => se.eventData),
      lastUpdateTime: storageSession.updateTime.getTime(),
      storageUpdateMarker: updateMarkerOf(storageSession),
    });
  }

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    await this.init();
    const em = this.orm!.em.fork();

    const where: FilterQuery<StorageSession> = {appName};
    if (userId) {
      where.userId = userId;
    }

    const orderBy =
      order === 'asc'
        ? {updateTime: 'ASC' as const, id: 'ASC' as const}
        : order === 'desc'
          ? {updateTime: 'DESC' as const, id: 'ASC' as const}
          : undefined;

    let storageSessions;
    let paginationMeta: Pick<
      ListSessionsResponse,
      'page' | 'limit' | 'totalItems' | 'totalPages'
    >;

    if (limit !== undefined) {
      const totalItems = await em.count(StorageSession, where);
      const totalPages = limit === 0 ? 0 : Math.ceil(totalItems / limit);

      let effectiveOffset: number;
      let effectivePage: number;
      if (page !== undefined) {
        effectiveOffset = (page - 1) * limit;
        effectivePage = page;
      } else {
        effectiveOffset = offset ?? 0;
        effectivePage =
          limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1;
      }

      storageSessions = await em.find(StorageSession, where, {
        orderBy,
        limit,
        offset: effectiveOffset,
      });
      paginationMeta = {page: effectivePage, limit, totalItems, totalPages};
    } else if (offset) {
      const totalItems = await em.count(StorageSession, where);
      storageSessions = await em.find(StorageSession, where, {
        orderBy,
        offset,
      });
      paginationMeta = {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    } else {
      storageSessions = await em.find(StorageSession, where, {orderBy});
      const totalItems = storageSessions.length;
      paginationMeta = {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    }

    const appStateModel = await em.findOne(StorageAppState, {appName});
    const appState = appStateModel?.state || {};
    const userStateMap: Record<string, Record<string, unknown>> = {};

    if (userId) {
      const u = await em.findOne(StorageUserState, {appName, userId});
      if (u) userStateMap[userId] = u.state;
    } else {
      const allUserStates = await em.find(StorageUserState, {appName});
      for (const u of allUserStates) {
        userStateMap[u.userId] = u.state;
      }
    }

    const sessions = storageSessions.map((ss) => {
      const uState = userStateMap[ss.userId] || {};
      const merged = mergeStates(appState, uState, ss.state);
      return createSession({
        id: ss.id,
        appName: ss.appName,
        userId: ss.userId,
        state: merged,
        events: [],
        lastUpdateTime: ss.updateTime.getTime(),
        storageUpdateMarker: updateMarkerOf(ss),
      });
    });

    return {sessions, ...paginationMeta};
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    await this.init();
    const em = this.orm!.em.fork();

    await em.nativeDelete(StorageSession, {appName, userId, id: sessionId});
    await em.nativeDelete(StorageEvent, {appName, userId, sessionId});
  }

  override async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    await this.init();
    const storageUserState = await this.orm!.em.fork().findOne(
      StorageUserState,
      {appName, userId},
    );
    return {...storageUserState?.state};
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.init();

    if (event.partial) {
      return event;
    }

    // Temp state stays readable for the rest of the invocation, so apply it to
    // the in-memory session before trimming it out of the persisted event.
    applyTempState({session, event});
    const trimmedEvent = trimTempDeltaState(event);
    const delta = extractStateDelta(trimmedEvent.actions.stateDelta ?? {});

    // JSON-encode the tuple so that ('a|b', 'c') and ('a', 'b|c') cannot
    // collide on one lock.
    const lockKey = JSON.stringify([
      session.appName,
      session.userId,
      session.id,
    ]);
    const revision = await this.sessionLocks.runExclusive(lockKey, () =>
      this.writeEvent(session, trimmedEvent, delta),
    );

    session.lastUpdateTime = revision.lastUpdateTime;
    session.storageUpdateMarker = revision.marker;

    return super.appendEvent({session, event: trimmedEvent});
  }

  /**
   * Writes one event and its state delta in a single transaction.
   *
   * @returns The storage revision the session reaches once the write commits.
   * @throws SessionNotFoundError if storage does not hold the session.
   * @throws StaleSessionError if storage has moved past the session's revision.
   */
  private async writeEvent(
    session: Session,
    event: Event,
    delta: ScopedStateDelta,
  ): Promise<{lastUpdateTime: number; marker: string}> {
    const hasAppDelta = Object.keys(delta.app).length > 0;
    const hasUserDelta = Object.keys(delta.user).length > 0;

    return this.orm!.em.fork().transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {appName: session.appName, userId: session.userId, id: session.id},
        writeLock(true),
      );
      if (!storageSession) {
        throw new SessionNotFoundError(`Session ${session.id} not found.`);
      }

      const storageAppState = await txEm.findOne(
        StorageAppState,
        {appName: session.appName},
        writeLock(hasAppDelta),
      );
      if (!storageAppState) {
        throw new Error(
          `App state missing for app_name='${session.appName}'. Session ` +
            'state tables should be initialized by createSession.',
        );
      }

      const storageUserState = await txEm.findOne(
        StorageUserState,
        {appName: session.appName, userId: session.userId},
        writeLock(hasUserDelta),
      );
      if (!storageUserState) {
        throw new Error(
          `User state missing for app_name='${session.appName}', ` +
            `user_id='${session.userId}'. Session state tables should be ` +
            'initialized by createSession.',
        );
      }

      await this.rejectStaleWrite(txEm, session, storageSession);

      applyScopedDelta(storageAppState, delta.app);
      applyScopedDelta(storageUserState, delta.user);
      applyScopedDelta(storageSession, delta.session);

      const existingStorageEvent = await txEm.findOne(StorageEvent, {
        id: event.id,
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });

      if (existingStorageEvent) {
        existingStorageEvent.eventData = event;
        existingStorageEvent.timestamp = new Date(event.timestamp);
      } else {
        txEm.persist(
          txEm.create(StorageEvent, {
            id: event.id,
            appName: session.appName,
            userId: session.userId,
            sessionId: session.id,
            invocationId: event.invocationId,
            timestamp: new Date(event.timestamp),
            eventData: event,
          }),
        );
      }

      storageSession.updateTime = new Date(event.timestamp);
      // Read the revision before the commit resolves, so the values reported
      // back describe exactly what storage now holds.
      return readRevision(txEm, storageSession);
    });
  }

  /**
   * Throws when the in-memory session is behind the stored revision.
   *
   * Also pulls the session's timestamp up to the stored one, so that a
   * round-trip that rounded the value does not read as stale next time.
   */
  private async rejectStaleWrite(
    txEm: EntityManager,
    session: Session,
    storageSession: StorageSession,
  ): Promise<void> {
    const storageMarker = updateMarkerOf(storageSession);
    const storageUpdateTime = storageSession.updateTime.getTime();

    if (session.storageUpdateMarker !== undefined) {
      if (session.storageUpdateMarker !== storageMarker) {
        throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
      }
      session.lastUpdateTime = storageUpdateTime;
    } else if (storageUpdateTime > session.lastUpdateTime) {
      if (!(await sessionMatchesStorageRevision(txEm, session))) {
        throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
      }
      session.lastUpdateTime = storageUpdateTime;
    }
    session.storageUpdateMarker = storageMarker;
  }
}
