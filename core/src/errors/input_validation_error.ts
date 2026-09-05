/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error raised when user input fails validation.
 */
export class InputValidationError extends Error {
  /**
   * @param message A message describing why the input is invalid.
   * @param options Standard error options, e.g. the `cause` that a validator
   *   reported before this error replaced it with a caller-facing message.
   */
  constructor(message = 'Invalid input.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'InputValidationError';
  }
}
