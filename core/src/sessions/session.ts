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
   * The exact storage revision this session was loaded at, set by persistent
   * session services.
   *
   * `FirestoreSessionService` compares it against the stored document on the
   * next write, so a session one process read does not overwrite a session
   * another process read earlier.
   *
   * This is internal bookkeeping: callers should not set it. A session built
   * by hand, or read from a service that tracks no revision, leaves it
   * undefined.
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
