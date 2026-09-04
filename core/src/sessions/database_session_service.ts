/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FilterQuery,
  LockMode,
  Options as MikroDBOptions,
  MikroORM,
} from '@mikro-orm/core';

import {Event} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  trimTempDeltaState,
} from './base_session_service.js';
import {
  assertSupportedDatabaseUri,
  ensureDatabaseCreated,
  forkForRead,
  forkForWrite,
  getConnectionOptionsFromUri,
  getDatabaseBackend,
  namesSupportedDatabaseBackend,
  openDatabaseOrm,
  supportsRowLevelLocking,
  validateDatabaseSchemaVersion,
} from './db/operations.js';
import {
  ENTITIES,
  StorageAppState,
  StorageEvent,
  StorageSession,
  StorageUserState,
} from './db/schema.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/**
 * Checks if a URI is a database connection URI.
 *
 * @param uri The URI to check.
 * @returns True if the URI is a database connection URI, false otherwise.
 */
export function isDatabaseConnectionString(uri?: string): boolean {
  return !!uri && namesSupportedDatabaseBackend(uri);
}

/** What the caller gave the constructor to open the database with. */
type DatabaseSource =
  | {uri: string; overrides?: Partial<MikroDBOptions>}
  | {options: MikroDBOptions};

/**
 * A session service that uses a SQL database for storage via MikroORM.
 */
export class DatabaseSessionService extends BaseSessionService {
  private connection?: Promise<MikroORM>;
  private readonly source: DatabaseSource;

  /**
   * @param connectionStringOrOptions A connection URI, or MikroORM options.
   * @param overrides Options applied on top of the ones the URI implies, for
   *   example a wider pool or a replacement liveness probe. They cannot be
   *   combined with an options object, which already carries them.
   */
  constructor(
    connectionStringOrOptions: MikroDBOptions | string,
    overrides?: Partial<MikroDBOptions>,
  ) {
    super();
    if (typeof connectionStringOrOptions === 'string') {
      // Reject a bad URI here rather than at the first query, matching
      // adk-python's engine construction.
      assertSupportedDatabaseUri(connectionStringOrOptions);
      this.source = {uri: connectionStringOrOptions, overrides};
    } else {
      if (overrides) {
        throw new Error(
          'Overrides cannot be combined with an options object. Apply them to' +
            ' the options directly.',
        );
      }
      if (!connectionStringOrOptions.driver) {
        throw new Error('Driver is required when passing options object.');
      }

      // Every backend adk-js supports drops the zone, so UTC is the default
      // here as it is for a URI. A caller's own value wins.
      this.source = {
        options: {
          ...connectionStringOrOptions,
          entities: ENTITIES,
          forceUtcTimezone: connectionStringOrOptions.forceUtcTimezone ?? true,
        },
      };
    }
  }

  async init() {
    await this.ready();
  }

  /**
   * Opens the database on the first call, and returns the open instance.
   *
   * @returns The initialized MikroORM instance.
   */
  private ready(): Promise<MikroORM> {
    // Memoize the in-flight connection so concurrent callers share one ORM,
    // and so `close()` can never race an `init()` into leaking one.
    this.connection ??= this.connect();
    return this.connection.catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
  }

  private async connect(): Promise<MikroORM> {
    const source = this.source;
    const orm =
      'options' in source
        ? await openDatabaseOrm(source.options)
        : await openDatabaseOrm(
            await getConnectionOptionsFromUri(source.uri, source.overrides),
            source.uri,
          );

    await ensureDatabaseCreated(orm);
    await validateDatabaseSchemaVersion(orm);
    return orm;
  }

  /**
   * Returns pooled connections and releases the database.
   *
   * Safe before {@link init} and safe to call twice. A later {@link init}
   * reopens the database.
   */
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) {
      return;
    }

    // A failed connection has nothing to close, and its error already reached
    // whoever called `init()`.
    const orm = await connection.catch(() => undefined);
    await orm?.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const em = forkForWrite(await this.ready());

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
    const em = forkForRead(await this.ready());

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

    // Get latest numRecentEvents events or all events in DESC order
    const storageEvents = await em.find(StorageEvent, eventWhere, {
      orderBy: {timestamp: 'DESC'},
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
    const em = forkForRead(await this.ready());

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
    await em.nativeDelete(StorageEvent, {appName, userId, sessionId});
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    const orm = await this.ready();
    const em = forkForWrite(orm);

    if (event.partial) {
      return event;
    }

    const trimmedEvent = trimTempDeltaState(event);
    // sqlite compiles `FOR UPDATE` away, and mssql turns it into a table hint
    // adk-python never takes. Only the dialects adk-python locks are asked
    // for a row-level lock.
    const lockMode = supportsRowLevelLocking(getDatabaseBackend(orm))
      ? LockMode.PESSIMISTIC_WRITE
      : undefined;

    await em.transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {
          appName: session.appName,
          userId: session.userId,
          id: session.id,
        },
        {lockMode},
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
