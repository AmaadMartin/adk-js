/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * Represents a unified composite session key grouping application, user, and session identifiers.
 */
export interface CompositeSessionKey {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
  /** The ID of the session. */
  sessionId: string;
}

/**
 * Represents a session in a conversation between agents and users.
 */
export interface Session {
  /**
   * The unique identifier of the session.
   */
  id: string;

  /**
   * The name of the app.
   */
  appName: string;

  /**
   * The id of the user.
   */
  userId: string;

  /**
   * The state of the session.
   */
  state: Record<string, unknown>;

  /**
   * The events of the session, e.g. user input, model response, function
   * call/response, etc.
   */
  events: Event[];

  /**
   * The last update time of the session.
   */
  lastUpdateTime: number;

  /**
   * The opaque storage revision this session was loaded at, set by persistent
   * session services.
   *
   * A session service that does optimistic concurrency control stamps this
   * when it loads the session, and checks it again on the next write. A
   * mismatch means another writer changed the session in storage since, so
   * the write is rejected with `StaleSessionError` instead of overwriting the
   * newer history. A service that does no such check leaves it unset.
   *
   * This is internal bookkeeping: callers should not set it. A session built
   * by hand, or read from a service that tracks no revision, leaves it
   * undefined, which selects the timestamp-based staleness fallback in
   * `DatabaseSessionService`.
   */
  storageUpdateMarker?: string;
}

/**
 * Creates a session from a partial session.
 *
 * @param params The partial session to create the session from.
 * @returns The session.
 */
export function createSession(
  params: Partial<Session> & {
    id: string;
    appName: string;
  },
): Session {
  return {
    id: params.id,
    appName: params.appName,
    userId: params.userId || '',
    state: params.state || {},
    events: params.events || [],
    lastUpdateTime: params.lastUpdateTime || 0,
    storageUpdateMarker: params.storageUpdateMarker,
  };
}
