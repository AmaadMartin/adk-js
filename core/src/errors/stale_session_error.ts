/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raised when a session write loses an optimistic concurrency race.
 *
 * A persistent session service stamps every session it returns with the
 * storage revision it was loaded at. `appendEvent` throws this error when
 * storage has advanced past that revision, instead of overwriting the newer
 * history. Recover by loading the session again with `getSession` and
 * replaying the append against the fresh copy.
 */
export class StaleSessionError extends Error {
  /**
   * @param message An optional custom message to describe the error.
   */
  constructor(
    message = 'The session has been modified in storage since it was loaded.',
  ) {
    super(message);
    this.name = 'StaleSessionError';
  }
}

/**
 * Type guard for {@link StaleSessionError}.
 *
 * Matches on the error name rather than the class, so it still holds when two
 * copies of this package share one runtime.
 */
export function isStaleSessionError(e: unknown): e is StaleSessionError {
  return e instanceof Error && e.name === 'StaleSessionError';
}
