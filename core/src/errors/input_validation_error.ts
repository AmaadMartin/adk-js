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
   *   underlying failure that made the input invalid, such as the schema error
   *   behind an invalid config document, the import error behind an
   *   unresolvable module name, or the validator error behind a refused
   *   response. A caller can then report the root problem instead of only the
   *   summary.
   */
  constructor(message = 'Invalid input.', options?: ErrorOptions) {
    super(message, options);
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
