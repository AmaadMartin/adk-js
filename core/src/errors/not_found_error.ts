/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error that occurs when an entity is not found.
 *
 * Parity with the adk-python `errors/not_found_error.py` `NotFoundError`.
 */
export class NotFoundError extends Error {
  /**
   * Creates a `NotFoundError`.
   *
   * @param message An optional custom message describing the error.
   */
  constructor(message = 'The requested item was not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}
