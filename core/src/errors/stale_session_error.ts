/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The message a session service raises with {@link StaleSessionError}. */
const STALE_SESSION_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/**
 * Raised when a session write loses an optimistic concurrency race.
 *
 * A session service that stamps `Session.storageUpdateMarker` throws this
 * when the marker no longer matches the revision in storage: another
 * writer changed the session after the caller loaded it. Reload the session
 * and append the event again.
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
