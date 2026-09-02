/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {InputValidationError} from '../errors/input_validation_error.js';
import {NotImplementedError} from '../errors/not_implemented_error.js';
import {Event} from '../events/event.js';

import {CompositeSessionKey, Session} from './session.js';
import {State} from './state.js';
import {carryDeltaStamps, shouldApplyDeltaWrite} from './state_write_order.js';

/**
 * The configuration of getting a session.
 */
export interface GetSessionConfig {
  /**
   * The number of recent events to retrieve. The filter is not applied when
   * omitted; `0` returns no events; a negative value is rejected by
   * {@link validateGetSessionConfig}.
   */
  numRecentEvents?: number;
  /** Retrieve events after this timestamp. */
  afterTimestamp?: number;
}

/**
 * The parameters for `createSession`.
 */
export interface CreateSessionRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
  /** The initial state of the session. */
  state?: Record<string, unknown>;
  /** The ID of the session. A new ID will be generated if not provided. */
  sessionId?: string;
}

/**
 * The parameters for `getSession`.
 */
export interface GetSessionRequest extends CompositeSessionKey {
  /** The configurations for getting the session. */
  config?: GetSessionConfig;
}

/**
 * The parameters for `getOrCreateSession`.
 */
export interface GetOrCreateSessionRequest extends CreateSessionRequest {
  /** Limits which events the lookup returns. Ignored when the session is created. */
  config?: GetSessionConfig;
}

/**
 * The parameters for `getUserState`.
 */
export interface GetUserStateRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
}

/**
 * The parameters for `listSessions`.
 */
export interface ListSessionsRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. Sessions of every user are listed if omitted. */
  userId?: string;
  /** Maximum number of sessions to return. */
  limit?: number;
  /** Zero-based index of the first session to return. Ignored if `page` is set. */
  offset?: number;
  /** 1-based page number. Requires `limit`. Takes precedence over `offset`. */
  page?: number;
  /**
   * Sort direction of the last-update-time key.
   *
   * Sessions come back oldest-first, with the user id and then the session id
   * breaking a tie, so that a paginated sweep cannot repeat or skip one. This
   * option only flips the direction of the update-time key.
   */
  order?: 'asc' | 'desc';
}

/**
 * The parameters for `deleteSession`.
 */
export type DeleteSessionRequest = CompositeSessionKey;

/**
 * The parameters for `appendEvent`.
 */
export interface AppendEventRequest {
  /** The session to append the event to. */
  session: Session;
  /** The event to append. */
  event: Event;
}

/**
 * The response of listing sessions.
 *
 * The events are not set within each Session object. The state is the same
 * merged view that `getSession` returns.
 * When no pagination params were requested, `page` is 1, `limit` equals
 * `totalItems`, and `totalPages` is 1 (or 0 when there are no sessions).
 */
export interface ListSessionsResponse {
  /** A list of sessions. */
  sessions: Session[];
  /** Current page number (1-based). */
  page: number;
  /** Page size used. Equals `totalItems` when no limit was requested. */
  limit: number;
  /** Total number of sessions matching the request. */
  totalItems: number;
  /** Total number of pages. */
  totalPages: number;
}

/**
 * Base class for session services.
 *
 * The service provides a set of methods for managing sessions and events.
 */
// TODO - b/425992518: can held session internally to make the API simpler.
export abstract class BaseSessionService {
  /**
   * Creates a new session.
   *
   * @param request The request to create a session.
   * @return A promise that resolves to the newly created session instance.
   */
  abstract createSession(request: CreateSessionRequest): Promise<Session>;

  /**
   * Gets a session.
   *
   * @param request The request to get a session.
   * @return A promise that resolves to the session instance or undefined if not
   *     found.
   */
  abstract getSession(request: GetSessionRequest): Promise<Session | undefined>;

  /**
   * Gets a session or creates one if it doesn't exist.
   *
   * @param request The request to get or create a session. `config` limits
   *     which events the lookup returns; it is ignored when the service has to
   *     create the session.
   * @return A promise that resolves to the session instance.
   */
  async getOrCreateSession(
    request: GetOrCreateSessionRequest,
  ): Promise<Session> {
    if (!request.sessionId) {
      return this.createSession(request);
    }
    const session = await this.getSession({
      appName: request.appName,
      userId: request.userId,
      sessionId: request.sessionId,
      config: request.config,
    });
    if (session) {
      return session;
    }
    return this.createSession(request);
  }

  /**
   * Lists sessions for a user.
   *
   * @param request The request to list sessions.
   * @return A promise that resolves to a list of sessions for the user.
   */
  abstract listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse>;

  /**
   * Deletes a session.
   *
   * @param request The request to delete a session.
   * @return A promise that resolves when the session is deleted.
   */
  abstract deleteSession(request: DeleteSessionRequest): Promise<void>;

  /**
   * Gets the user-scoped state for an app and user.
   *
   * User state is keyed by `(appName, userId)` and is shared by every session
   * that user has in that app. The returned keys are raw, without the `user:`
   * prefix, and the result is empty when nothing has been stored.
   *
   * Reading user state through this method needs no session id, so a caller
   * can bootstrap context before the first turn instead of paying for a
   * `listSessions` sweep.
   *
   * @param _request The app and user to read the state of. The default
   *     implementation ignores it and throws.
   * @return A promise that resolves to the raw user-scoped key/value pairs.
   * @throws {NotImplementedError} When the concrete service cannot read user
   *     state independently of a session. Callers can instead enumerate
   *     sessions with `listSessions` and call `getSession` on each result to
   *     reach the merged state.
   */
  async getUserState(
    _request: GetUserStateRequest,
  ): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      `${this.constructor.name} does not support getUserState. To read user ` +
        'state, enumerate sessions via listSessions and call getSession on ' +
        'each result to access the merged state.',
    );
  }

  /**
   * Flushes any buffered events.
   *
   * A service that buffers writes overrides this. The default does nothing.
   *
   * @return A promise that resolves when the buffered events are written.
   */
  async flush(): Promise<void> {}

  /**
   * Appends an event to a session.
   *
   * @param request The request to append an event.
   * @return A promise that resolves to the event that was appended.
   */
  async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    // Temp values have to reach the in-memory session before the delta is
    // trimmed, so a later agent in the same invocation can read them.
    applyTempDeltaState(session, event);
    event = trimTempDeltaState(event);

    if (event.actions?.stateDelta) {
      applyStateDelta(session.state, event.actions.stateDelta);
    }
    upsertEvent(session.events, event);

    return event;
  }
}

/**
 * Appends an event to an event list, replacing an entry that already carries
 * the same id.
 *
 * An event id names one logical event, so an event that reuses a stored id
 * revises that entry instead of adding a second one. Every event list a
 * session service keeps follows this rule, so a caller's session and the
 * stored session hold the same events.
 *
 * @param events The event list to write into.
 * @param event The event to append or revise.
 */
export function upsertEvent(events: Event[], event: Event): void {
  const index = events.findIndex((e) => e.id === event.id);
  if (index >= 0) {
    events[index] = event;
  } else {
    events.push(event);
  }
}

/**
 * Commits the entries of a state delta into a state object.
 *
 * `temp:` entries are never committed: they live for the current invocation
 * only.
 *
 * @param state The state to write into.
 * @param stateDelta The delta to commit.
 */
export function applyStateDelta(
  state: Record<string, unknown>,
  stateDelta: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(stateDelta)) {
    if (key.startsWith(State.TEMP_PREFIX)) {
      continue;
    }
    // Commits lag the writes they carry, and events arrive here in the order
    // they were streamed rather than the order their writes happened.
    // Applying an entry that a newer write already superseded would roll the
    // key back until that newer event commits in turn; skip it instead.
    if (!shouldApplyDeltaWrite(state, stateDelta, key)) {
      continue;
    }
    defineStateEntry(state, key, value);
  }
}

/**
 * Stores one state entry on a session state map.
 *
 * `session.state` is not always a null-prototype map — a caller can hand us a
 * session whose state is a plain object literal — and on a plain object
 * `state['__proto__'] = value` reaches the inherited `__proto__` setter, which
 * replaces the object's prototype instead of storing the entry.
 * `defineProperty` always creates an own property.
 */
function defineStateEntry(
  state: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(state, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Copies the `temp:`-prefixed delta keys onto the in-memory session state.
 *
 * Temp state is ephemeral: it stays readable for the rest of the current
 * invocation, so a later agent in the same turn can see it, but
 * `trimTempDeltaState` keeps it out of the persisted event. Call this before
 * trimming.
 *
 * This is the request-shaped spelling of {@link applyTempDeltaState}, which
 * holds the implementation.
 */
export function applyTempState({session, event}: AppendEventRequest): void {
  applyTempDeltaState(session, event);
}

/**
 * Applies the temporary state delta keys of an event to the in-memory session
 * state.
 *
 * Temp state is ephemeral: it stays readable on `session.state` for the rest of
 * the current invocation, and {@link trimTempDeltaState} keeps it out of the
 * event that reaches storage. Call this before the trim, or there is nothing
 * left to read.
 */
export function applyTempDeltaState(session: Session, event: Event): void {
  if (!event.actions?.stateDelta) {
    return;
  }
  for (const [key, value] of Object.entries(event.actions.stateDelta)) {
    if (!key.startsWith(State.TEMP_PREFIX)) {
      continue;
    }
    // Same rollback guard the committed keys get: a temp key written directly
    // through a node's `ctx.state` must not be reverted by an older commit.
    if (!shouldApplyDeltaWrite(session.state, event.actions.stateDelta, key)) {
      continue;
    }
    // Plain assignment is safe: a `temp:`-prefixed key can never be the string
    // `__proto__`, which is what `updateSessionState` needs `defineProperty`
    // for.
    session.state[key] = value;
  }
}

/**
 * Rejects a session configuration that cannot be satisfied.
 *
 * @throws {InputValidationError} When `numRecentEvents` is negative.
 */
export function validateGetSessionConfig(config?: GetSessionConfig): void {
  if (config?.numRecentEvents !== undefined && config.numRecentEvents < 0) {
    throw new InputValidationError(
      'numRecentEvents must be greater than or equal to 0.',
    );
  }
}

/**
 * Removes temporary state delta keys from the event.
 */
export function trimTempDeltaState(event: Event): Event {
  if (!event.actions || !event.actions.stateDelta) {
    return event;
  }

  const stateDelta = event.actions.stateDelta;
  // Null-prototype: the caller controls these keys, and copying a `__proto__`
  // key into a plain object literal invokes the inherited `__proto__` setter,
  // which drops the entry and re-parents the map. See `trimTempState`.
  const filteredStateDelta: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(stateDelta)) {
    if (!key.startsWith(State.TEMP_PREFIX)) {
      filteredStateDelta[key] = value;
    }
  }

  // The rebuilt map is a different object, so the write order recorded against
  // the old one has to come with it or the commit loses its ordering.
  carryDeltaStamps(stateDelta, filteredStateDelta);
  event.actions.stateDelta = filteredStateDelta;
  return event;
}

/**
 * Removes temporary state keys from the state.
 *
 * The result is a null-prototype map. `state` comes straight off the request
 * body on a dev server (`POST /apps/:appName/users/:userId/sessions/:sessionId`),
 * and `JSON.parse` makes `__proto__` an own key, so copying it into a plain
 * object literal would invoke the inherited `__proto__` setter: the entry is
 * dropped and the new state object is re-parented onto the attacker's object.
 * `State.get`/`State.has` use the `in` operator, so every key on that object
 * would then read back as session state.
 */
export function trimTempState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filteredState: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith(State.TEMP_PREFIX)) {
      filteredState[key] = value;
    }
  }
  return filteredState;
}

/**
 * A state delta split by the scope each entry belongs to.
 */
export interface ScopedStateDelta {
  /** App-scoped entries, with the `app:` prefix stripped. */
  app: Record<string, unknown>;
  /** User-scoped entries, with the `user:` prefix stripped. */
  user: Record<string, unknown>;
  /** Session-scoped entries. */
  session: Record<string, unknown>;
}

/**
 * Splits a state delta into its app-, user- and session-scoped parts.
 *
 * Each scope is stored separately by a persistent session service, so the
 * `app:` and `user:` prefixes are stripped. `temp:` entries are dropped: they
 * are never persisted.
 *
 * The three maps are null-prototype, because the keys can come straight off a
 * request body. Assigning `__proto__` to a plain object literal reaches the
 * inherited setter and re-parents the map instead of storing the entry.
 */
export function extractStateDelta(
  state: Record<string, unknown>,
): ScopedStateDelta {
  const delta: ScopedStateDelta = {
    app: Object.create(null),
    user: Object.create(null),
    session: Object.create(null),
  };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(State.APP_PREFIX)) {
      delta.app[key.slice(State.APP_PREFIX.length)] = value;
    } else if (key.startsWith(State.USER_PREFIX)) {
      delta.user[key.slice(State.USER_PREFIX.length)] = value;
    } else if (!key.startsWith(State.TEMP_PREFIX)) {
      delta.session[key] = value;
    }
  }
  // The session bucket is a different object, so the write order recorded
  // against the original has to come with it or the commit loses its ordering.
  carryDeltaStamps(state, delta.session);
  return delta;
}

/**
 * Merges app state, user state, and session state.
 *
 * @param appState The application state.
 * @param userState The user state.
 * @param sessionState The session state.
 * @return The merged state.
 */
export function mergeStates(
  appState: Record<string, unknown> = {},
  userState: Record<string, unknown> = {},
  sessionState: Record<string, unknown> = {},
) {
  const merged = cloneDeep(sessionState);
  for (const [k, v] of Object.entries(appState)) {
    merged[State.APP_PREFIX + k] = v;
  }
  for (const [k, v] of Object.entries(userState)) {
    merged[State.USER_PREFIX + k] = v;
  }
  return merged;
}
