/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityManager,
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
import {logger} from '../utils/logger.js';
import {isMissingOptionalPeerError} from '../utils/optional_peer.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {
  AppendEventRequest,
  applyTempState,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  extractStateDelta,
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
  databaseBackendOf,
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  EventFilter,
  getConnectionOptionsFromUri,
  getOrCreateRow,
  namesSupportedDatabaseBackend,
  NEWEST_EVENT_FIRST,
  READ_ONLY,
  SessionSchema,
  sessionSchemaFor,
  supportsRowLevelLocking,
  validateDatabaseSchemaVersion,
} from './db/operations.js';
import {
  ENTITIES,
  SCHEMA_VERSION_0_PICKLE,
  SCHEMA_VERSION_1_JSON,
  StorageAppState,
  StorageEvent,
  StorageSession,
  StorageUserState,
} from './db/schema.js';
import {ENTITIES_V0} from './db/schema_v0.js';
import {CompositeSessionKey, createSession, Session} from './session.js';

/**
 * The message a stale write is rejected with. The wording matches adk-python,
 * because it reaches the user and both SDKs are tested against it.
 */
const STALE_SESSION_ERROR_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/** The command that turns a legacy v0 database into one this SDK can write. */
const MIGRATE_COMMAND = 'the adk-python `adk migrate session` command';

/** Why a write against a legacy v0 database is refused. */
const LEGACY_READ_ONLY_MESSAGE =
  'This database uses the legacy v0 session schema, which stores event ' +
  'actions as a Python pickle. adk-js can read it but cannot write it, ' +
  'because a write would leave the actions unreadable to adk-python. ' +
  `Migrate the database with ${MIGRATE_COMMAND} first.`;

/** Why a caller-supplied MikroORM instance cannot open a legacy database. */
const LEGACY_CALLER_ORM_MESSAGE =
  'This database uses the legacy v0 session schema, which needs its own ' +
  'entity set. MikroORM fixes the entity set when the instance is created, ' +
  'so a caller-supplied instance cannot be switched over. Construct ' +
  'DatabaseSessionService from a connection string instead, or migrate the ' +
  `database with ${MIGRATE_COMMAND}.`;

/** Says once that the actions of every legacy event read back empty. */
const LEGACY_ACTIONS_WARNING =
  'This database uses the legacy v0 session schema, which stores event ' +
  'actions as a Python pickle. adk-js cannot decode it, so every event is ' +
  `returned with empty actions. Migrate the database with ${MIGRATE_COMMAND} ` +
  'to recover them.';

/** Selects the sessions of one app, optionally narrowed to one user. */
type SessionFilter = {
  appName: string;
  userId?: string;
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

/**
 * Restates a failure to open the database, naming the URL it happened on.
 *
 * Mirrors the fallback branches of adk-python's engine construction: a driver
 * that is not installed reads differently from a database that refused the
 * connection, and neither should surface a raw driver stack trace. The URL is
 * redacted, and a caller who supplied a MikroORM instance or an options object
 * has no URL to name.
 *
 * @param error The failure MikroORM or the driver loader raised.
 * @param uri The connection string, if the caller gave one.
 */
function describeOpenFailure(error: unknown, uri?: string): Error {
  const target =
    uri === undefined ? 'the database' : `'${redactUriPassword(uri)}'`;
  const reason = isMissingOptionalPeerError(error)
    ? `Database related module not found for URL ${target}`
    : `Failed to create database engine for URL ${target}`;
  return new Error(reason, {cause: error});
}

/** The exact storage revision a session row is currently at. */
function updateMarkerOf(storageSession: {updateTime: Date}): string {
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
  private schema: SessionSchema = sessionSchemaFor(SCHEMA_VERSION_1_JSON);
  private legacyDatabase = false;
  private backend = '';
  private warnedAboutLegacyActions = false;

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
      assertSupportedDatabaseUri(source);
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
    const orm = (this.orm ??= await this.openOrm(ENTITIES));

    // Detect before creating anything: `ensureDatabaseCreated` adds the v1
    // `event_data` column to a legacy `events` table, which erases the
    // evidence the detection reads.
    const version = await detectDatabaseSchemaVersion(orm);
    if (version === SCHEMA_VERSION_0_PICKLE) {
      // Neither create tables nor stamp a version: both would make a legacy
      // database report itself as current while its events read back empty.
      await this.reopenWithLegacyEntities();
    } else {
      await ensureDatabaseCreated(orm);
      await validateDatabaseSchemaVersion(orm);
    }

    this.backend = databaseBackendOf(this.orm!);
    this.initialized = true;
  }

  /**
   * Opens a MikroORM instance over the configured source.
   *
   * @param entities The entity set to register, which MikroORM fixes for the
   *     lifetime of the instance.
   * @throws Error naming the connection URL with its password masked.
   */
  private async openOrm(
    entities: MikroDBOptions['entities'],
  ): Promise<MikroORM> {
    try {
      return await MikroORM.init({...(await this.resolveOptions()), entities});
    } catch (error: unknown) {
      throw describeOpenFailure(error, this.connectionString);
    }
  }

  /**
   * Reopens the database with the legacy v0 entity set.
   *
   * The entity set is fixed at `MikroORM.init` time, so reading a legacy
   * database means closing the instance opened with the current entities and
   * opening a second one.
   *
   * @throws Error if the caller supplied the MikroORM instance.
   */
  private async reopenWithLegacyEntities(): Promise<void> {
    if (!this.ownsOrm) {
      throw new Error(LEGACY_CALLER_ORM_MESSAGE);
    }
    const opened = this.orm;
    this.orm = undefined;
    await opened?.close();

    this.orm = await this.openOrm(ENTITIES_V0);
    this.schema = sessionSchemaFor(SCHEMA_VERSION_0_PICKLE);
    this.legacyDatabase = true;
  }

  private async resolveOptions(): Promise<MikroDBOptions> {
    return this.connectionString === undefined
      ? this.options!
      : getConnectionOptionsFromUri(
          this.connectionString,
          this.optionOverrides,
        );
  }

  /** Rejects a write that a legacy v0 database cannot accept. */
  private assertWritable(): void {
    if (this.legacyDatabase) {
      throw new Error(LEGACY_READ_ONLY_MESSAGE);
    }
  }

  /** A fork that cannot flush, for the read paths. */
  private readEm(): EntityManager {
    return this.orm!.em.fork({disableTransactions: true});
  }

  /**
   * Releases the database connections this service opened.
   *
   * The sqlite driver holds an open connection on the event loop, so a
   * short-lived process that never calls this never exits. A MikroORM instance
   * supplied by the caller stays open, because the caller owns it. Calling this
   * twice, or before `init`, does nothing.
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
    this.assertWritable();
    const em = this.orm!.em.fork();

    const id = sessionId || randomUUID();
    const now = new Date();
    if (sessionId && (await this.sessionExists({appName, userId, id}))) {
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
    validateGetSessionConfig(config);

    await this.init();
    const em = this.readEm();

    const storageSession = await em.findOne(
      this.schema.sessions,
      {appName, userId, id: sessionId},
      {...READ_ONLY},
    );

    if (!storageSession) {
      return undefined;
    }

    const events = await this.findEvents(
      em,
      {appName, userId, sessionId},
      config,
    );

    const appStateModel = await em.findOne(
      this.schema.appStates,
      {appName},
      {...READ_ONLY},
    );
    const userStateModel = await em.findOne(
      this.schema.userStates,
      {appName, userId},
      {...READ_ONLY},
    );

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
      events,
      lastUpdateTime: storageSession.updateTime.getTime(),
      storageUpdateMarker: updateMarkerOf(storageSession),
    });
  }

  override async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    await this.init();

    const userStateModel = await this.readEm().findOne(
      this.schema.userStates,
      {appName, userId},
      {...READ_ONLY},
    );
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

    const events = await this.schema.readEvents(
      em,
      where,
      config?.numRecentEvents,
    );
    if (events.length > 0) {
      this.warnOnceAboutLegacyActions();
    }
    return events;
  }

  /** Says once per service that legacy events come back without actions. */
  private warnOnceAboutLegacyActions(): void {
    if (this.legacyDatabase && !this.warnedAboutLegacyActions) {
      this.warnedAboutLegacyActions = true;
      logger.warn(LEGACY_ACTIONS_WARNING);
    }
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
    const em = this.readEm();

    const where: SessionFilter = {appName};
    if (userId) {
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
      const totalItems = await em.count(this.schema.sessions, where, {
        ...READ_ONLY,
      });
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

      storageSessions = await em.find(this.schema.sessions, where, {
        ...READ_ONLY,
        orderBy,
        limit,
        offset: effectiveOffset,
      });
      paginationMeta = {page: effectivePage, limit, totalItems, totalPages};
    } else if (offset) {
      const totalItems = await em.count(this.schema.sessions, where, {
        ...READ_ONLY,
      });
      storageSessions = await em.find(this.schema.sessions, where, {
        ...READ_ONLY,
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
      storageSessions = await em.find(this.schema.sessions, where, {
        ...READ_ONLY,
        orderBy,
      });
      const totalItems = storageSessions.length;
      paginationMeta = {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    }

    const appStateModel = await em.findOne(
      this.schema.appStates,
      {appName},
      {...READ_ONLY},
    );
    const appState = appStateModel?.state || {};
    const userStateMap: Record<string, Record<string, unknown>> = {};

    if (userId) {
      const u = await em.findOne(
        this.schema.userStates,
        {appName, userId},
        {...READ_ONLY},
      );
      if (u) userStateMap[userId] = u.state;
    } else {
      const allUserStates = await em.find(
        this.schema.userStates,
        {appName},
        {...READ_ONLY},
      );
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
    this.assertWritable();
    const em = this.orm!.em.fork();

    await em.nativeDelete(StorageSession, {appName, userId, id: sessionId});
    await em.nativeDelete(StorageEvent, {appName, userId, sessionId});
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.init();
    this.assertWritable();

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
    const useRowLevelLocking = supportsRowLevelLocking(this.backend);

    return this.orm!.em.fork().transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {appName: session.appName, userId: session.userId, id: session.id},
        writeLock(useRowLevelLocking),
      );
      if (!storageSession) {
        throw new SessionNotFoundError(`Session ${session.id} not found.`);
      }

      const storageAppState = await txEm.findOne(
        StorageAppState,
        {appName: session.appName},
        writeLock(useRowLevelLocking && hasAppDelta),
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
        writeLock(useRowLevelLocking && hasUserDelta),
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
