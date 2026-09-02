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

import {Event} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
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
import {
  assertSupportedDatabaseUri,
  detectDatabaseSchemaVersion,
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  getOrCreateRow,
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
import {
  ENTITIES_V0,
  StorageEventV0,
  storageEventV0ToEvent,
} from './db/schema_v0.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/**
 * adk-python's unconditional `update_time asc, user_id asc, id asc`. The tie
 * breaks keep a paginated sweep from repeating or skipping a row.
 */
const OLDEST_SESSION_FIRST = {
  updateTime: 'ASC',
  userId: 'ASC',
  id: 'ASC',
} as const;

const NEWEST_SESSION_FIRST = {
  updateTime: 'DESC',
  userId: 'ASC',
  id: 'ASC',
} as const;

/**
 * Newest event first, ties broken on id. Without the tie break the database
 * may return tied events in a different order on every read, so a replayed
 * conversation shuffles and `numRecentEvents` truncates inside the tie.
 */
const NEWEST_EVENT_FIRST = {timestamp: 'DESC', id: 'DESC'} as const;

const EXACTLY_ONE_SOURCE_MESSAGE =
  'Exactly one of a database URL, MikroORM options, or a MikroORM instance' +
  ' must be provided.';

const OPTIONS_WITH_INSTANCE_MESSAGE =
  'Options cannot be applied to a MikroORM instance the caller already built.' +
  ' Pass a connection string or an options object instead.';

const LEGACY_READ_ONLY_MESSAGE =
  'This database uses the legacy v0 session schema, which stores event' +
  ' actions as a Python pickle. adk-js can read such a database but cannot' +
  ' write to it. Migrate it with the adk-python `adk migrate session`' +
  ' command first.';

const LEGACY_CALLER_ORM_MESSAGE =
  'This database uses the legacy v0 session schema. Reading it needs the' +
  ' legacy entity set, which this service can only install on a connection it' +
  ' opened itself. Construct it with a connection string or an options object' +
  ' rather than a MikroORM instance.';

const LEGACY_EMPTY_ACTIONS_MESSAGE =
  'Event actions read from a legacy v0 database come back empty, because they' +
  ' are stored as a Python pickle that adk-js cannot decode.';

/**
 * Reports whether `source` is a MikroORM instance rather than its options.
 *
 * Structural, because `instanceof` returns false across two copies of
 * `@mikro-orm/core` in one runtime.
 */
function isMikroOrmInstance(
  source: MikroDBOptions | MikroORM,
): source is MikroORM {
  return 'em' in source && 'schema' in source && 'close' in source;
}

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

/**
 * A session service that uses a SQL database for storage via MikroORM.
 */
export class DatabaseSessionService extends BaseSessionService {
  private orm?: MikroORM;
  private initialized = false;
  private options?: MikroDBOptions;
  private connectionString?: string;
  private optionOverrides?: Partial<MikroDBOptions>;
  private ownsOrm = true;
  private legacySchema = false;
  private warnedAboutLegacyActions = false;

  /**
   * @param source A connection URL, MikroORM options, or a MikroORM instance
   *   the caller already built and continues to own.
   * @param overrides Options applied on top of the ones the URL implies. They
   *   cannot be combined with a MikroORM instance.
   */
  constructor(
    source: MikroDBOptions | MikroORM | string,
    overrides?: Partial<MikroDBOptions>,
  ) {
    super();

    if (!source) {
      throw new Error(EXACTLY_ONE_SOURCE_MESSAGE);
    }

    if (typeof source === 'string') {
      // Reject a bad URL here rather than on the first query, matching
      // adk-python's engine construction.
      assertSupportedDatabaseUri(source);
      this.connectionString = source;
      this.optionOverrides = overrides;
      return;
    }

    if (isMikroOrmInstance(source)) {
      if (overrides) {
        throw new Error(OPTIONS_WITH_INSTANCE_MESSAGE);
      }
      this.orm = source;
      this.ownsOrm = false;
      return;
    }

    if (!source.driver) {
      throw new Error('Driver is required when passing options object.');
    }

    this.options = {...source, ...overrides, entities: ENTITIES};
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (this.connectionString) {
      this.options = await getConnectionOptionsFromUri(
        this.connectionString,
        this.optionOverrides,
      );
    }

    if (!this.orm) {
      this.orm = await MikroORM.init(this.options!);
    }

    // Detection has to run first: creating the current tables adds an
    // `event_data` column to a legacy `events` table, which destroys the
    // evidence it reads.
    const version = await detectDatabaseSchemaVersion(this.orm);
    if (version === SCHEMA_VERSION_0_PICKLE) {
      await this.reopenWithLegacyEntities();
      this.initialized = true;
      return;
    }

    await ensureDatabaseCreated(this.orm!);
    await validateDatabaseSchemaVersion(this.orm!);
    this.initialized = true;
  }

  /**
   * Releases the database connection.
   *
   * A MikroORM instance the caller supplied stays open, because the caller
   * owns it. Calling this twice, or before {@link init}, does nothing.
   */
  async close(): Promise<void> {
    this.initialized = false;

    if (!this.ownsOrm || !this.orm) {
      return;
    }

    const orm = this.orm;
    this.orm = undefined;
    await orm.close();
  }

  /**
   * Swaps the current entity set for the legacy one.
   *
   * Neither the tables nor the metadata row is written: doing so would turn a
   * readable legacy database into one that reports itself as current while its
   * events read back empty.
   */
  private async reopenWithLegacyEntities(): Promise<void> {
    if (!this.ownsOrm) {
      throw new Error(LEGACY_CALLER_ORM_MESSAGE);
    }

    const previous = this.orm!;
    // Clear first, so a failed retry does not leave a closed instance
    // installed.
    this.orm = undefined;
    await previous.close();

    this.orm = await MikroORM.init({...this.options!, entities: ENTITIES_V0});
    this.legacySchema = true;
  }

  /** Throws when the open database is one adk-js can only read. */
  private assertWritable(): void {
    if (this.legacySchema) {
      throw new Error(LEGACY_READ_ONLY_MESSAGE);
    }
  }

  private warnAboutLegacyActionsOnce(): void {
    if (this.warnedAboutLegacyActions) {
      return;
    }
    this.warnedAboutLegacyActions = true;
    logger.warn(LEGACY_EMPTY_ACTIONS_MESSAGE);
  }

  /** Reads a session's events, newest first, then restores their order. */
  private async findSessionEvents(
    em: EntityManager,
    appName: string,
    userId: string,
    sessionId: string,
    config?: GetSessionConfig,
  ): Promise<Event[]> {
    if (config?.numRecentEvents === 0) {
      // Existence/metadata-only read; skip the events query entirely.
      return [];
    }

    const limit = config?.numRecentEvents;
    const afterTimestamp = config?.afterTimestamp;

    if (this.legacySchema) {
      const where: FilterQuery<StorageEventV0> = {appName, userId, sessionId};
      if (afterTimestamp !== undefined) {
        where.timestamp = {$gte: new Date(afterTimestamp)};
      }
      const rows = await em.find(StorageEventV0, where, {
        orderBy: NEWEST_EVENT_FIRST,
        limit,
      });
      rows.reverse();
      this.warnAboutLegacyActionsOnce();
      return rows.map(storageEventV0ToEvent);
    }

    const where: FilterQuery<StorageEvent> = {appName, userId, sessionId};
    if (afterTimestamp !== undefined) {
      where.timestamp = {$gte: new Date(afterTimestamp)};
    }
    const rows = await em.find(StorageEvent, where, {
      orderBy: NEWEST_EVENT_FIRST,
      limit,
    });
    rows.reverse();
    return rows.map((row) => row.eventData);
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
    const existing = await em.findOne(StorageSession, {
      id,
      appName,
      userId,
    });
    if (existing) {
      throw new Error(`Session with id ${id} already exists.`);
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

    const appStateDelta: Record<string, unknown> = {};
    const userStateDelta: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};

    if (state) {
      for (const [key, value] of Object.entries(state)) {
        if (key.startsWith(State.APP_PREFIX)) {
          appStateDelta[key.replace(State.APP_PREFIX, '')] = value;
        } else if (key.startsWith(State.USER_PREFIX)) {
          userStateDelta[key.replace(State.USER_PREFIX, '')] = value;
        } else if (!key.startsWith(State.TEMP_PREFIX)) {
          sessionState[key] = value;
        }
      }
    }

    if (Object.keys(appStateDelta).length > 0) {
      appStateModel.state = {...appStateModel.state, ...appStateDelta};
    }
    if (Object.keys(userStateDelta).length > 0) {
      userStateModel.state = {...userStateModel.state, ...userStateDelta};
    }

    const storageSession = em.create(StorageSession, {
      id,
      appName,
      userId,
      state: sessionState,
      createTime: now,
      updateTime: now,
    });
    em.persist(storageSession);

    await em.flush();

    const mergedState = mergeStates(
      appStateModel.state,
      userStateModel.state,
      sessionState,
    );

    return createSession({
      id,
      appName,
      userId,
      state: mergedState,
      events: [],
      lastUpdateTime: storageSession.createTime.getTime(),
    });
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

    const events = await this.findSessionEvents(
      em,
      appName,
      userId,
      sessionId,
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

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergedState,
      events,
      lastUpdateTime: storageSession.updateTime.getTime(),
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
      return createSession({
        id: ss.id,
        appName: ss.appName,
        userId: ss.userId,
        state: merged,
        events: [],
        lastUpdateTime: ss.updateTime.getTime(),
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
    this.assertWritable();
    const em = this.orm!.em.fork();

    if (event.partial) {
      return event;
    }

    const trimmedEvent = trimTempDeltaState(event);

    await em.transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {
          appName: session.appName,
          userId: session.userId,
          id: session.id,
        },
        {lockMode: LockMode.PESSIMISTIC_WRITE},
      );

      if (!storageSession) {
        throw new Error(`Session ${session.id} not found for appendEvent`);
      }

      let appStateModel = await txEm.findOne(StorageAppState, {
        appName: session.appName,
      });
      if (!appStateModel) {
        appStateModel = txEm.create(StorageAppState, {
          appName: session.appName,
          state: {},
          updateTime: new Date(),
        });
        txEm.persist(appStateModel);
      }

      let userStateModel = await txEm.findOne(StorageUserState, {
        appName: session.appName,
        userId: session.userId,
      });
      if (!userStateModel) {
        userStateModel = txEm.create(StorageUserState, {
          appName: session.appName,
          userId: session.userId,
          state: {},
        });
        txEm.persist(userStateModel);
      }

      // Stale session check
      if (storageSession.updateTime.getTime() > session.lastUpdateTime) {
        // Reload state
        const events = await txEm.find(
          StorageEvent,
          {
            appName: session.appName,
            userId: session.userId,
            sessionId: session.id,
          },
          {orderBy: {timestamp: 'ASC'}},
        );

        const mergedState = mergeStates(
          appStateModel.state,
          userStateModel.state,
          storageSession.state,
        );
        session.state = mergedState;
        session.events = events.map((e) => e.eventData);
      }

      if (event.actions && event.actions.stateDelta) {
        const appDelta: Record<string, unknown> = {};
        const userDelta: Record<string, unknown> = {};
        const sessionDelta: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(event.actions.stateDelta)) {
          if (key.startsWith(State.APP_PREFIX)) {
            appDelta[key.replace(State.APP_PREFIX, '')] = value;
          } else if (key.startsWith(State.USER_PREFIX)) {
            userDelta[key.replace(State.USER_PREFIX, '')] = value;
          } else if (!key.startsWith(State.TEMP_PREFIX)) {
            sessionDelta[key] = value;
          }
        }

        if (Object.keys(appDelta).length > 0) {
          appStateModel.state = {...appStateModel.state, ...appDelta};
        }
        if (Object.keys(userDelta).length > 0) {
          userStateModel.state = {...userStateModel.state, ...userDelta};
        }
        if (Object.keys(sessionDelta).length > 0) {
          storageSession.state = {...storageSession.state, ...sessionDelta};
        }
      }

      const existingStorageEvent = await txEm.findOne(StorageEvent, {
        id: trimmedEvent.id,
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });

      if (existingStorageEvent) {
        existingStorageEvent.eventData = trimmedEvent;
        existingStorageEvent.timestamp = new Date(trimmedEvent.timestamp);
        txEm.persist(existingStorageEvent);
      } else {
        const newStorageEvent = txEm.create(StorageEvent, {
          id: trimmedEvent.id,
          appName: session.appName,
          userId: session.userId,
          sessionId: session.id,
          invocationId: trimmedEvent.invocationId,
          timestamp: new Date(trimmedEvent.timestamp),
          eventData: trimmedEvent,
        });
        txEm.persist(newStorageEvent);
      }
      await txEm.commit();

      storageSession.updateTime = new Date(event.timestamp);

      const newMergedState = mergeStates(
        appStateModel.state,
        userStateModel.state,
        storageSession.state,
      );
      session.state = newMergedState;

      const index = session.events.findIndex((e) => e.id === event.id);
      if (index >= 0) {
        session.events[index] = event;
      } else {
        session.events.push(event);
      }
      session.lastUpdateTime = storageSession.updateTime.getTime();
    });

    return event;
  }
}
