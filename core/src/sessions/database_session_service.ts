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
import {
  AppendEventRequest,
  applyTempState,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionConfig,
  GetSessionRequest,
  GetUserStateRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  ScopedStateDelta,
  trimTempDeltaState,
  validateGetSessionConfig,
} from './base_session_service.js';
import {
  assertSupportedDatabaseUri,
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  getOrCreateRow,
  namesSupportedDatabaseBackend,
  openDatabaseOrm,
  supportsRowLevelLocking,
  validateDatabaseSchemaVersion,
} from './db/operations.js';
import {
  ENTITIES,
  getUpdateTimestamp,
  SCHEMA_VERSION_0_PICKLE,
  StorageAppState,
  StorageEvent,
  storageEventFromEvent,
  storageEventToEvent,
  StorageSession,
  StorageUserState,
  toSession,
} from './db/schema.js';
import {
  ENTITIES_V0,
  StorageEventV0,
  storageEventV0FromEvent,
  storageEventV0ToEvent,
  updateStorageEventV0,
} from './db/schema_v0.js';
import {CompositeSessionKey, Session} from './session.js';
import {extractJsonSafeStateDelta} from './session_util.js';

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
 * Selects the events of one session, optionally from a timestamp onwards.
 *
 * Spelled out rather than built from `CompositeSessionKey`, because MikroORM's
 * `FilterQuery` only accepts a type that carries an implicit index signature,
 * which an interface does not have.
 */
type EventFilter = {
  appName: string;
  userId: string;
  sessionId: string;
  timestamp?: {$gte: Date};
};

/**
 * Oldest session first, with the user id and then the session id breaking a
 * tie. A total order is what makes `limit`/`offset`/`page` well defined: two
 * pages of an unordered query can repeat a session and skip another.
 */
const OLDEST_SESSION_FIRST = {
  updateTime: 'ASC',
  userId: 'ASC',
  id: 'ASC',
} as const;

/** Newest session first, keeping the tie-break keys ascending. */
const NEWEST_SESSION_FIRST = {
  updateTime: 'DESC',
  userId: 'ASC',
  id: 'ASC',
} as const;

/**
 * Checks if a URI is a database connection URI.
 *
 * A URI whose scheme also names a driver, such as `postgresql+asyncpg://`,
 * counts: the backend is one this service owns, so the service is the right
 * place for the caller to be told what is wrong with the scheme.
 *
 * @param uri The URI to check.
 * @returns True if the URI is a database connection URI, false otherwise.
 */
export function isDatabaseConnectionString(uri?: string): boolean {
  return uri !== undefined && namesSupportedDatabaseBackend(uri);
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
    lastUpdateTime: getUpdateTimestamp(stored),
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

/** The event entity registered for the layout the open database holds. */
type StorageEventEntity = typeof StorageEvent | typeof StorageEventV0;

/**
 * Reports whether a marker-less session still matches the stored history.
 *
 * A session built by hand carries no revision marker, so the newest stored
 * event stands in for one: the caller is current when it holds that event, or
 * when both it and storage hold none.
 *
 * @param eventEntity The event entity the open database registers. A legacy
 *     database registers `StorageEventV0`, and reading `StorageEvent` there
 *     fails because MikroORM does not know it.
 */
async function sessionMatchesStorageRevision(
  em: EntityManager,
  eventEntity: StorageEventEntity,
  session: Session,
): Promise<boolean> {
  const newestStored = await em.findOne(
    eventEntity,
    {appName: session.appName, userId: session.userId, sessionId: session.id},
    {orderBy: NEWEST_EVENT_FIRST},
  );
  return newestStored?.id === session.events.at(-1)?.id;
}

/**
 * Stores one event in a v1 database, replacing the row it already holds.
 *
 * @param txEm The entity manager of the open write transaction.
 * @param storageSession The stored session row the event belongs to.
 * @param event The event to store.
 */
async function persistEventRow(
  txEm: EntityManager,
  storageSession: StorageSession,
  event: Event,
): Promise<void> {
  const existing = await txEm.findOne(StorageEvent, {
    id: event.id,
    appName: storageSession.appName,
    userId: storageSession.userId,
    sessionId: storageSession.id,
  });

  if (existing) {
    existing.eventData = event;
    existing.timestamp = new Date(event.timestamp);
    return;
  }
  txEm.persist(
    txEm.create(StorageEvent, storageEventFromEvent(storageSession, event)),
  );
}

/**
 * Stores one event in a legacy v0 database, replacing the row it already
 * holds.
 *
 * The `actions` column receives the Python pickle adk-python's restricted
 * unpickler reads back, so a row written here stays loadable from Python.
 *
 * @param txEm The entity manager of the open write transaction.
 * @param session The session the event belongs to.
 * @param event The event to store.
 * @throws If the event's actions hold a value with no Python counterpart.
 */
async function persistLegacyEventRow(
  txEm: EntityManager,
  session: Session,
  event: Event,
): Promise<void> {
  const existing = await txEm.findOne(StorageEventV0, {
    id: event.id,
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
  });

  if (existing) {
    updateStorageEventV0(existing, session, event);
    return;
  }
  txEm.persist(storageEventV0FromEvent(session, event));
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
  private legacySchema = false;

  /**
   * @param source A connection string, a MikroORM options object, or a
   *     MikroORM instance the caller already initialized and continues to own.
   * @param overrides Options merged over the ones the connection string
   *     implies, for example a wider pool or a replacement liveness probe.
   *     They cannot be combined with an options object or with a MikroORM
   *     instance, because both already carry them.
   * @throws Error if the connection string is not one this service supports.
   */
  constructor(
    source: MikroDBOptions | MikroORM | string,
    overrides?: Partial<MikroDBOptions>,
  ) {
    super();
    if (!source) {
      throw new Error(
        'Exactly one of a database URL, MikroORM options, or a MikroORM' +
          ' instance must be provided.',
      );
    }

    if (typeof source === 'string') {
      // Reject a bad URL here rather than on the first query, matching
      // adk-python's engine construction.
      assertSupportedDatabaseUri(source);
      this.connectionString = source;
      this.optionOverrides = overrides;
      this.ownsOrm = true;
      return;
    }

    if (isMikroORM(source)) {
      if (overrides) {
        throw new Error(
          'Options cannot be applied to a MikroORM instance the caller' +
            ' already built. Pass a connection string or an options object' +
            ' instead.',
        );
      }
      this.orm = source;
      this.ownsOrm = false;
      return;
    }

    if (overrides) {
      throw new Error(
        'Overrides cannot be combined with an options object. Apply them to' +
          ' the options directly.',
      );
    }
    if (!source.driver) {
      throw new Error('Driver is required when passing options object.');
    }
    // Every backend adk-js supports drops the zone, so UTC is the default
    // here as it is for a URL. A caller's own value wins.
    this.options = {
      ...source,
      entities: ENTITIES,
      forceUtcTimezone: source.forceUtcTimezone ?? true,
    };
    this.ownsOrm = true;
  }

  /**
   * Connects to the database and prepares its tables.
   *
   * Callers do not need this: every method initializes on demand. Call it
   * during startup to pay the cost upfront. It is safe to call more than once
   * and safe to call concurrently, and a failed attempt can be retried.
   *
   * A database holding the legacy v0 schema keeps that layout: a missing v0
   * table or index is created, and no v1 table, column or metadata row is
   * added to it.
   *
   * @throws Error if the database holds the legacy v0 session schema and the
   *     caller supplied the MikroORM instance.
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
    const orm = (this.orm ??= await openDatabaseOrm(
      await this.resolveOptions(),
      this.connectionString,
    ));

    // Detect before creating anything: `ensureDatabaseCreated` adds the v1
    // `event_data` column to a legacy `events` table, which erases the
    // evidence the detection reads.
    const version = await detectDatabaseSchemaVersion(orm);
    if (version === SCHEMA_VERSION_0_PICKLE) {
      await this.reopenWithLegacyEntities();
      // `ENTITIES_V0` carries no `StorageMetadata`, so this creates a missing
      // v0 table and a missing events index without adding
      // `adk_internal_metadata`. `validateDatabaseSchemaVersion` stays off
      // this path: it writes a `schema_version = '1'` row, and adk-python's
      // `prepare_tables` writes that row only for the latest version.
      await ensureDatabaseCreated(this.orm!);
      this.initialized = true;
      return;
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
   * Initializes the service on demand, and returns the open database.
   *
   * @returns The initialized MikroORM instance.
   */
  private async ready(): Promise<MikroORM> {
    await this.init();
    return this.orm!;
  }

  /**
   * Releases the database connections this service opened.
   *
   * The sqlite driver keeps its file open until the pool closes, so a
   * short-lived process that never calls this never exits, and a caller that
   * has finished with a database has no other way to let go of it. A MikroORM
   * instance supplied by the caller stays open, because the caller owns it.
   * Calling this twice, or before `init`, does nothing.
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

  /** Closes the service at the end of an `await using` block. */
  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Swaps the current entity set for the legacy one.
   *
   * The metadata row stays unwritten: claiming the latest version for a
   * database that still holds pickled actions would send the next reader to
   * the wrong entity set.
   *
   * @throws Error if the caller supplied the MikroORM instance, because the
   *     service cannot change the entity set of a connection it did not open.
   */
  private async reopenWithLegacyEntities(): Promise<void> {
    if (!this.ownsOrm) {
      throw new Error(
        'This database uses the legacy v0 session schema. Reading it needs' +
          ' the legacy entity set, which this service can only install on a' +
          ' connection it opened itself. Construct it with a connection' +
          ' string or an options object rather than a MikroORM instance.',
      );
    }

    const options = await this.resolveOptions();
    const previous = this.orm!;
    // Clear first, so a failed retry does not leave a closed instance
    // installed.
    this.orm = undefined;
    await previous.close();

    this.orm = await openDatabaseOrm(
      {...options, entities: ENTITIES_V0},
      this.connectionString,
    );
    this.legacySchema = true;
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const em = forkForWrite(await this.ready());

    const id = sessionId?.trim() || randomUUID();
    const now = new Date();
    if (sessionId && (await this.sessionExists(em, {appName, userId, id}))) {
      throw new AlreadyExistsError(`Session with id ${id} already exists.`);
    }

    const appStateModel = await getOrCreateRow(
      em,
      StorageAppState,
      {appName},
      {appName, state: {}, updateTime: now},
    );
    const userStateModel = await getOrCreateRow(
      em,
      StorageUserState,
      {appName, userId},
      {appName, userId, state: {}, updateTime: now},
    );

    const delta = extractJsonSafeStateDelta(state ?? {});
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
      // On its own fork: `em` holds the write that just failed, and reusing
      // it would flush that write again.
      if (
        await this.sessionExists(forkForRead(this.orm!), {appName, userId, id})
      ) {
        throw new AlreadyExistsError(`Session with id ${id} already exists.`);
      }
      throw error;
    }

    const mergedState = mergeStates(
      appStateModel.state,
      userStateModel.state,
      delta.session,
    );

    // `readRevision` refreshed the row in place, so `storageSession` already
    // holds the `update_time` the marker was taken from.
    return toSession(storageSession, {
      state: mergedState,
      storageUpdateMarker: revision.marker,
    });
  }

  private async sessionExists(
    em: EntityManager,
    key: {appName: string; userId: string; id: string},
  ): Promise<boolean> {
    return (await em.count(StorageSession, key)) > 0;
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    validateGetSessionConfig(config);

    const em = forkForRead(await this.ready());

    const storageSession = await em.findOne(StorageSession, {
      appName,
      userId,
      id: sessionId,
    });

    if (!storageSession) {
      return undefined;
    }

    const events = await this.findEvents(
      em,
      {appName, userId, sessionId},
      config,
    );

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

    return toSession(storageSession, {
      state: mergedState,
      events,
      storageUpdateMarker: updateMarkerOf(storageSession),
    });
  }

  override async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    const em = forkForRead(await this.ready());

    const userStateModel = await em.findOne(StorageUserState, {
      appName,
      userId,
    });
    return {...(userStateModel?.state ?? {})};
  }

  /**
   * Reads the stored events of one session, oldest first.
   *
   * A `numRecentEvents` of zero makes this an existence or metadata-only
   * read, so the query is skipped rather than issued with a limit no dialect
   * defines.
   */
  private async findEvents(
    em: EntityManager,
    key: CompositeSessionKey,
    config?: GetSessionConfig,
  ): Promise<Event[]> {
    if (config?.numRecentEvents === 0) {
      return [];
    }

    const where: EventFilter = {...key};
    if (config?.afterTimestamp) {
      // Inclusive, matching adk-python: a caller passing the timestamp of a
      // known event receives that event.
      where.timestamp = {$gte: new Date(config.afterTimestamp)};
    }

    const options = {
      orderBy: NEWEST_EVENT_FIRST,
      limit: config?.numRecentEvents,
    };

    if (this.legacySchema) {
      const legacyEvents = await em.find(StorageEventV0, where, options);
      return legacyEvents.reverse().map(storageEventV0ToEvent);
    }

    const storageEvents = await em.find(StorageEvent, where, options);
    storageEvents.reverse();
    return storageEvents.map(storageEventToEvent);
  }

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const em = forkForRead(await this.ready());

    const where: FilterQuery<StorageSession> = {appName};
    // An empty user id is a user id. Falsiness here returned every user's
    // sessions for the app; adk-python filters on `if user_id is not None`.
    if (userId !== undefined) {
      where.userId = userId;
    }

    const orderBy =
      order === 'desc' ? NEWEST_SESSION_FIRST : OLDEST_SESSION_FIRST;

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

    if (userId !== undefined) {
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
      return toSession(ss, {
        state: merged,
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
    const em = forkForWrite(await this.ready());

    await em.nativeDelete(StorageSession, {appName, userId, id: sessionId});
    if (this.legacySchema) {
      await em.nativeDelete(StorageEventV0, {appName, userId, sessionId});
      return;
    }
    await em.nativeDelete(StorageEvent, {appName, userId, sessionId});
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
    const delta = extractJsonSafeStateDelta(
      trimmedEvent.actions.stateDelta ?? {},
    );

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
    // sqlite compiles `FOR UPDATE` away, and mssql turns it into a table hint
    // adk-python never takes. Only the dialects adk-python locks are asked
    // for a row-level lock.
    const locks = supportsRowLevelLocking(getDatabaseBackend(this.orm!));

    return forkForWrite(this.orm!).transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {appName: session.appName, userId: session.userId, id: session.id},
        writeLock(locks),
      );
      if (!storageSession) {
        throw new SessionNotFoundError(`Session ${session.id} not found.`);
      }

      const storageAppState = await txEm.findOne(
        StorageAppState,
        {appName: session.appName},
        writeLock(locks && hasAppDelta),
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
        writeLock(locks && hasUserDelta),
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

      if (this.legacySchema) {
        await persistLegacyEventRow(txEm, session, event);
      } else {
        await persistEventRow(txEm, storageSession, event);
      }

      storageSession.updateTime = new Date(event.timestamp);
      // Read the revision before the commit resolves, so the values reported
      // back describe exactly what storage now holds.
      return readRevision(txEm, storageSession);
    });
  }

  /**
   * Throws when the in-memory session no longer matches the stored revision.
   *
   * Also pulls the session's timestamp to the stored one, so that a round-trip
   * that rounded the value does not read as stale next time.
   *
   * A marker-less session compares the stored time for any difference, not
   * just a later stored time: another writer can leave `update_time` BEHIND
   * the reader's own, because `appendEvent` sets the column to its event's
   * timestamp. The stored history then decides whether the session is really
   * stale, so a backend that rounds the column — MySQL and MariaDB round a
   * `DATETIME` to whole seconds — costs one extra event read and no error.
   */
  private async rejectStaleWrite(
    txEm: EntityManager,
    session: Session,
    storageSession: StorageSession,
  ): Promise<void> {
    const storageMarker = updateMarkerOf(storageSession);
    const storageUpdateTime = getUpdateTimestamp(storageSession);

    if (session.storageUpdateMarker !== undefined) {
      if (session.storageUpdateMarker !== storageMarker) {
        throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
      }
      session.lastUpdateTime = storageUpdateTime;
    } else if (storageUpdateTime !== session.lastUpdateTime) {
      const eventEntity = this.legacySchema ? StorageEventV0 : StorageEvent;
      if (!(await sessionMatchesStorageRevision(txEm, eventEntity, session))) {
        throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
      }
      session.lastUpdateTime = storageUpdateTime;
    }
    session.storageUpdateMarker = storageMarker;
  }
}
