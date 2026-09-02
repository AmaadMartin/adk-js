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
   * @param options Standard error options. Pass `cause` to keep the
   *   structured validation failure that made the input invalid, so that a
   *   caller can report the root problem instead of only the summary.
   */
  constructor(message = 'Invalid input.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'InputValidationError';
  }
}
