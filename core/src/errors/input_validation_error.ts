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
 * Reports whether an unknown value is an {@link InputValidationError}.
 *
 * The check reads `name` instead of using `instanceof`, so it stays correct
 * when two copies of adk-js share one runtime and the error crosses from one
 * to the other.
 *
 * @param e The value to check, normally a caught error.
 * @return True when the value is an input validation error.
 */
export function isInputValidationError(e: unknown): e is InputValidationError {
  return e instanceof Error && e.name === 'InputValidationError';
}
