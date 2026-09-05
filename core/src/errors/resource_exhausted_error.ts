/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** HTTP status the model returns when a quota is exhausted. */
const RESOURCE_EXHAUSTED_STATUS = 429;

/** Points a developer at the public guide for quota errors. */
export const RESOURCE_EXHAUSTED_MITIGATION_MESSAGE =
  'On how to mitigate this issue, please refer to:\n\n' +
  'https://google.github.io/adk-docs/agents/models/google-gemini/#error-code-429-resource_exhausted';

/**
 * Raised when the model rejects a call because a quota is exhausted.
 *
 * The message carries the mitigation guide ahead of the originating error's
 * own message, so a console line or a log entry shows both.
 */
export class ResourceExhaustedError extends Error {
  readonly status: number = RESOURCE_EXHAUSTED_STATUS;

  /**
   * @param cause The error the google-genai SDK raised.
   */
  constructor(cause: Error) {
    super(`${RESOURCE_EXHAUSTED_MITIGATION_MESSAGE}\n\n${cause.message}`, {
      cause,
    });
    this.name = 'ResourceExhaustedError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, ResourceExhaustedError.prototype);
  }
}

/**
 * Type guard for {@link ResourceExhaustedError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct
 * when errors cross a package boundary (two copies of adk-js in one runtime
 * would fail an `instanceof` check between them).
 */
export function isResourceExhaustedError(
  e: unknown,
): e is ResourceExhaustedError {
  return e instanceof Error && e.name === 'ResourceExhaustedError';
}

/**
 * Converts an HTTP 429 from the google-genai SDK into a
 * {@link ResourceExhaustedError}.
 *
 * @param e The value a model call threw.
 * @returns The enriched error, or `undefined` when `e` is not a quota error.
 */
export function asResourceExhaustedError(
  e: unknown,
): ResourceExhaustedError | undefined {
  if (
    e instanceof Error &&
    'status' in e &&
    e.status === RESOURCE_EXHAUSTED_STATUS
  ) {
    return new ResourceExhaustedError(e);
  }
  return undefined;
}
