/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The message used when a caller does not supply one. */
const DEFAULT_MESSAGE = 'The resource already exists.';

/**
 * Raised when an entity a caller asked to create is already present.
 *
 * Ported from `google/adk-python` `errors/already_exists_error.py`.
 */
export class AlreadyExistsError extends Error {
  constructor(message: string = DEFAULT_MESSAGE) {
    super(message);
    this.name = 'AlreadyExistsError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, AlreadyExistsError.prototype);
  }
}

/**
 * Type guard for {@link AlreadyExistsError}.
 *
 * Matches on `name` rather than `instanceof` so it stays correct when the error
 * crosses a package boundary (two copies of adk-js in one runtime would fail an
 * `instanceof` check between them).
 */
export function isAlreadyExistsError(e: unknown): e is AlreadyExistsError {
  return e instanceof Error && e.name === 'AlreadyExistsError';
}
