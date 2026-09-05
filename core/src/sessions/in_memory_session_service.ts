/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {cloneDeep, isEqual} from 'lodash-es';

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {Event} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {
  AppendEventRequest,
  applyStateDelta,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  extractStateDelta,
  GetSessionRequest,
  GetUserStateRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  upsertEvent,
} from './base_session_service.js';
import {createSession, Session} from './session.js';

/**
 * Checks if the given URI is an in-memory memory service URI.
 */
export function isInMemoryConnectionString(uri?: string): boolean {
  return uri === 'memory://';
}

/**
 * Builds the comparator that orders a listed page of sessions.
 *
 * Sessions run oldest-first unless `order` is `'desc'`. Ties break on user ID
 * and then session ID, ascending in both directions, so that a list is stable
 * across calls.
 */
function compareSessions(
  order: ListSessionsRequest['order'],
): (a: Session, b: Session) => number {
  const direction = order === 'desc' ? -1 : 1;
  return (a, b) =>
    direction * (a.lastUpdateTime - b.lastUpdateTime) ||
    a.userId.localeCompare(b.userId) ||
    a.id.localeCompare(b.id);
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
    const trimmedId = sessionId?.trim();
    if (trimmedId && this.sessions[appName]?.[userId]?.[trimmedId]) {
      throw new AlreadyExistsError(
        `Session with id ${trimmedId} already exists.`,
      );
    }

    const {app, user, session: sessionState} = extractStateDelta(state ?? {});
    this.writeScopedState(appName, userId, app, user);

    const session = createSession({
      id: trimmedId || randomUUID(),
      appName,
      userId,
      state: sessionState,
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

    const copiedSession = cloneDeep(session);
    copiedSession.state = mergeStates(
      this.appState[appName],
      this.userState[appName]?.[userId],
      copiedSession.state,
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
    const copiedSession = cloneDeep(session);

    if (config) {
      if (config.numRecentEvents !== undefined) {
        copiedSession.events =
          config.numRecentEvents === 0
            ? []
            : copiedSession.events.slice(-config.numRecentEvents);
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

    copiedSession.state = mergeStates(
      this.appState[appName],
      this.userState[appName]?.[userId],
      copiedSession.state,
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

    const all: Session[] = sessionsByUser.flatMap((sessionsById) =>
      Object.values(sessionsById).map((session) =>
        createSession({
          id: session.id,
          appName: session.appName,
          userId: session.userId,
          // `session.userId` rather than the request's, which may be omitted.
          state: mergeStates(
            this.appState[appName],
            this.userState[appName]?.[session.userId],
            session.state,
          ),
          events: [],
          lastUpdateTime: session.lastUpdateTime,
        }),
      ),
    );

    all.sort(compareSessions(order));

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

  override async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    return {...(this.userState[appName]?.[userId] ?? {})};
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

    const warning = (message: string) => {
      logger.warn(`Failed to append event to session ${sessionId}: ${message}`);
    };

    if (!this.sessions[appName]) {
      warning(`appName ${appName} not in sessions`);
      return event;
    }

    if (!this.sessions[appName][userId]) {
      warning(`userId ${userId} not in sessions[appName]`);
      return event;
    }

    if (!this.sessions[appName][userId][sessionId]) {
      warning(`sessionId ${sessionId} not in sessions[appName][userId]`);
      return event;
    }

    const storageSession: Session = this.sessions[appName][userId][sessionId];
    // A broadcast can deliver one event to several references of the same
    // session, as the same object or as an equal copy, and applying its state
    // delta twice would double-count it. An event that reuses a stored id with
    // new content is a revision, not a re-delivery, so it is not equal and
    // `upsertEvent` replaces the stored entry.
    if (
      storageSession.events.some((e) => e.id === event.id && isEqual(e, event))
    ) {
      return event;
    }

    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    if (storageSession !== session) {
      upsertEvent(storageSession.events, event);
      storageSession.lastUpdateTime = event.timestamp;
    }

    const {
      app,
      user,
      session: sessionDelta,
    } = extractStateDelta(event.actions?.stateDelta ?? {});
    this.writeScopedState(appName, userId, app, user);
    applyStateDelta(storageSession.state, sessionDelta);

    return event;
  }

  /**
   * Writes the app- and user-scoped buckets of a state delta into the stores
   * they are shared through.
   */
  private writeScopedState(
    appName: string,
    userId: string,
    app: Record<string, unknown>,
    user: Record<string, unknown>,
  ): void {
    if (Object.keys(app).length > 0) {
      this.appState[appName] ??= Object.create(null);
      Object.assign(this.appState[appName], app);
    }
    if (Object.keys(user).length > 0) {
      this.userState[appName] ??= Object.create(null);
      this.userState[appName][userId] ??= Object.create(null);
      Object.assign(this.userState[appName][userId], user);
    }
  }
}
