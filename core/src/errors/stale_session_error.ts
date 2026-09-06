/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The message a session service raises with {@link StaleSessionError}.
 *
 * The wording matches adk-python, because it reaches the user and both SDKs
 * are tested against it.
 */
const STALE_SESSION_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/**
 * Raised when a session write loses an optimistic concurrency race.
 *
 * A persistent session service stamps every session it returns with the
 * storage revision it was loaded at, in `Session.storageUpdateMarker`.
 * `appendEvent` throws this error when storage has advanced past that
 * revision, instead of overwriting the newer history. Recover by loading the
 * session again with `getSession` and replaying the append against the fresh
 * copy.
 */
export class StaleSessionError extends Error {
  /**
   * @param message An optional custom message to describe the error.
   */
  constructor(message = STALE_SESSION_MESSAGE) {
    super(message);
    this.name = 'StaleSessionError';
  }
}

/** Type guard for {@link StaleSessionError}. */
export function isStaleSessionError(e: unknown): e is StaleSessionError {
  return e instanceof Error && e.name === 'StaleSessionError';
}
