/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errors raised by the session services.
 *
 * Ported from `google/adk-python` `errors/_stale_session_error.py`.
 */

const STALE_SESSION_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/**
 * Raised when a session write loses an optimistic concurrency race.
 *
 * The caller holds a `Session` that storage has moved past, so its append was
 * rejected. Reload the session and decide whether to replay the event.
 */
export class StaleSessionError extends Error {
  constructor(message = STALE_SESSION_MESSAGE) {
    super(message);
    this.name = 'StaleSessionError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, StaleSessionError.prototype);
  }
}

/**
 * Type guard for {@link StaleSessionError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct when
 * errors cross a package boundary (two copies of adk-js in one runtime would
 * fail an `instanceof` check between them).
 */
export function isStaleSessionError(e: unknown): e is StaleSessionError {
  return e instanceof Error && e.name === 'StaleSessionError';
}
