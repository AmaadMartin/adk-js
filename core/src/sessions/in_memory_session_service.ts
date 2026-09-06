/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {cloneDeep} from 'lodash-es';

import {SessionNotFoundError} from '../errors/session_not_found_error.js';
import {Event} from '../events/event.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  trimTempState,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/**
 * Checks if the given URI is an in-memory memory service URI.
 */
export function isInMemoryConnectionString(uri?: string): boolean {
  return uri === 'memory://';
}

/**
 * Returns the copy of a stored session that the caller owns.
 *
 * With `IN_MEMORY_SESSION_SERVICE_LIGHT_COPY` off the copy is a deep clone.
 * With it on only the containers are copied: the caller can add an event or a
 * state key without touching the stored session, but the event objects and
 * state values are shared, which avoids a recursive clone of every event on
 * every read.
 */
function copySession(session: Session): Session {
  if (!isFeatureEnabled(FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY)) {
    return cloneDeep(session);
  }
  return {
    ...session,
    events: [...session.events],
    // `Object.assign` onto a null-prototype target rather than a `{...state}`
    // literal: state keys are caller-controlled, and `State` looks them up
    // with `in`, so a plain literal would hand back every key of
    // `Object.prototype` as session state.
    state: Object.assign(Object.create(null), session.state),
  };
}

/**
 * Writes the app- and user-scoped store entries into a session copy's state.
 *
 * `copySession` has already produced the state object the caller owns, so the
 * extra clone `mergeStates` performs would be paid twice on the deep path and
 * would undo the light one.
 */
function mergeScopedState(
  target: Record<string, unknown>,
  appState: Record<string, unknown> = {},
  userState: Record<string, unknown> = {},
): void {
  for (const [key, value] of Object.entries(appState)) {
    target[State.APP_PREFIX + key] = value;
  }
  for (const [key, value] of Object.entries(userState)) {
    target[State.USER_PREFIX + key] = value;
  }
}

/**
 * An in-memory implementation of the session service.
 *
 * Every map below is keyed by untrusted input — `appName`, `userId`,
 * `sessionId` and state keys all arrive straight off the request path or body
 * on a dev server — so each is created with `Object.create(null)`. On an
 * ordinary `{}` literal a key of `__proto__` resolves to the inherited
 * `__proto__` accessor instead of creating an own property, so
 * `map[appName][userId] = ...` writes onto `Object.prototype` and pollutes
 * every object in the process. A null-prototype map has no such accessor, so
 * those keys become ordinary own properties.
 */
export class InMemorySessionService extends BaseSessionService {
  /**
   * A map from app name to a map from user ID to a map from session ID to
   * session.
   */
  private sessions: Record<string, Record<string, Record<string, Session>>> =
    Object.create(null);

  /**
   * A map from app name to a map from user ID to a map from key to the value.
   */
  private userState: Record<string, Record<string, Record<string, unknown>>> =
    Object.create(null);

  /**
   * A map from app name to a map from key to the value.
   */
  private appState: Record<string, Record<string, unknown>> =
    Object.create(null);

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const filteredState = state ? trimTempState(state) : undefined;
    const session = createSession({
      id: sessionId || randomUUID(),
      appName,
      userId,
      state: filteredState,
      events: [],
      lastUpdateTime: Date.now(),
    });

    if (!this.sessions[appName]) {
      this.sessions[appName] = Object.create(null);
    }
    if (!this.sessions[appName][userId]) {
      this.sessions[appName][userId] = Object.create(null);
    }

    this.sessions[appName][userId][session.id] = session;

    const copiedSession = copySession(session);
    mergeScopedState(
      copiedSession.state,
      this.appState[appName],
      this.userState[appName]?.[userId],
    );

    return copiedSession;
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    if (
      !this.sessions[appName] ||
      !this.sessions[appName][userId] ||
      !this.sessions[appName][userId][sessionId]
    ) {
      return Promise.resolve(undefined);
    }

    const session: Session = this.sessions[appName][userId][sessionId];
    const copiedSession = copySession(session);

    if (config) {
      if (config.numRecentEvents) {
        copiedSession.events = copiedSession.events.slice(
          -config.numRecentEvents,
        );
      }
      if (config.afterTimestamp) {
        let i = copiedSession.events.length - 1;
        while (i >= 0) {
          if (copiedSession.events[i].timestamp < config.afterTimestamp) {
            break;
          }
          i--;
        }
        if (i >= 0) {
          copiedSession.events = copiedSession.events.slice(i + 1);
        }
      }
    }

    mergeScopedState(
      copiedSession.state,
      this.appState[appName],
      this.userState[appName]?.[userId],
    );

    return copiedSession;
  }

  listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const appSessions = this.sessions[appName];
    // An omitted `userId` lists every user's sessions, the same as the
    // filter-less branches in `VertexAiSessionService` and
    // `DatabaseSessionService`.
    const sessionsByUser =
      appSessions === undefined
        ? []
        : userId === undefined
          ? Object.values(appSessions)
          : appSessions[userId]
            ? [appSessions[userId]]
            : [];

    if (sessionsByUser.length === 0) {
      if (limit !== undefined) {
        const effectiveOffset =
          page !== undefined ? (page - 1) * limit : (offset ?? 0);
        const effectivePage =
          page !== undefined
            ? page
            : limit === 0
              ? 1
              : Math.floor(effectiveOffset / limit) + 1;
        return Promise.resolve({
          sessions: [],
          page: effectivePage,
          limit,
          totalItems: 0,
          totalPages: 0,
        });
      }
      return Promise.resolve({
        sessions: [],
        page: 1,
        limit: 0,
        totalItems: 0,
        totalPages: 0,
      });
    }

    const all: Session[] = sessionsByUser.flatMap((sessionsById) =>
      Object.values(sessionsById).map((session) =>
        createSession({
          id: session.id,
          appName: session.appName,
          userId: session.userId,
          state: {},
          events: [],
          lastUpdateTime: session.lastUpdateTime,
        }),
      ),
    );

    if (order === 'asc') {
      all.sort(
        (a, b) =>
          a.lastUpdateTime - b.lastUpdateTime || a.id.localeCompare(b.id),
      );
    } else if (order === 'desc') {
      all.sort(
        (a, b) =>
          b.lastUpdateTime - a.lastUpdateTime || a.id.localeCompare(b.id),
      );
    }

    if (limit === undefined) {
      const totalItems = all.length;
      const sliced = offset ? all.slice(offset) : all;
      return Promise.resolve({
        sessions: sliced,
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      });
    }

    const totalItems = all.length;
    const totalPages = limit === 0 ? 0 : Math.ceil(totalItems / limit);

    let effectiveOffset: number;
    let effectivePage: number;
    if (page !== undefined) {
      effectiveOffset = (page - 1) * limit;
      effectivePage = page;
    } else {
      effectiveOffset = offset ?? 0;
      effectivePage = limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1;
    }

    const paginated = all.slice(effectiveOffset, effectiveOffset + limit);

    return Promise.resolve({
      sessions: paginated,
      page: effectivePage,
      limit,
      totalItems,
      totalPages,
    });
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const session = await this.getSession({appName, userId, sessionId});

    if (!session) {
      return;
    }

    delete this.sessions[appName][userId][sessionId];
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    const appName = session.appName;
    const userId = session.userId;
    const sessionId = session.id;

    // The lookup precedes every mutation, so a caller holding a deleted or
    // never-created session learns that the append did not happen instead of
    // half-applying its state delta.
    const storageSession = this.sessions[appName]?.[userId]?.[sessionId];
    if (!storageSession) {
      throw new SessionNotFoundError(`Session ${sessionId} not found.`);
    }

    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    if (event.actions && event.actions.stateDelta) {
      for (const key of Object.keys(event.actions.stateDelta)) {
        if (key.startsWith(State.APP_PREFIX)) {
          this.appState[appName] =
            this.appState[appName] || Object.create(null);
          this.appState[appName][key.replace(State.APP_PREFIX, '')] =
            event.actions.stateDelta[key];
        }

        if (key.startsWith(State.USER_PREFIX)) {
          this.userState[appName] =
            this.userState[appName] || Object.create(null);
          this.userState[appName][userId] =
            this.userState[appName][userId] || Object.create(null);
          this.userState[appName][userId][key.replace(State.USER_PREFIX, '')] =
            event.actions.stateDelta[key];
        }
      }
    }

    await super.appendEvent({session: storageSession, event});
    storageSession.lastUpdateTime = event.timestamp;

    return event;
  }
}
