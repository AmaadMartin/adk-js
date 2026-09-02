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
   */
  constructor(message = 'Invalid input.') {
    super(message);
    this.name = 'InputValidationError';
  }
}

/**
 * Type guard for {@link InputValidationError}.
 *
 * Matches on `name` rather than `instanceof` so it stays correct when errors
 * cross a package boundary (two copies of adk-js in one runtime would fail an
 * `instanceof` check between them).
 */
export function isInputValidationError(e: unknown): e is InputValidationError {
  return e instanceof Error && e.name === 'InputValidationError';
}
