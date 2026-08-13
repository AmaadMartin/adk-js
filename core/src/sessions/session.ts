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
}

/**
 * Compares two session ids for the `listSessions` tie-break on an equal
 * `lastUpdateTime`.
 *
 * Compares by UTF-16 code unit rather than by locale-aware (ICU) collation, so
 * an in-process sort agrees with the `ORDER BY id` that a SQL-backed service
 * pushes down to the database. ICU orders `['B', 'a', 'A', 'b']` as a, A, b, B;
 * a binary collation orders it A, B, a, b.
 */
export function compareSessionIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  };
}
