/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derives the `error.type` label for a failure.
 *
 * Prefers, in order: a pre-classified `errorType` carried by the error; the
 * HTTP status of a `@google/genai` `ApiError` (the SDK reports every failed
 * request through that one class, so only the status tells a 429 from a 400);
 * and finally the error's name, falling back to its class name when the name
 * has been blanked out.
 *
 * The `ApiError` case is matched on the shape of the error rather than with
 * `instanceof`: two copies of `@google/genai` can coexist in one dependency
 * tree, and an error raised by one copy is not an `instanceof` the class of
 * the other.
 *
 * @param error The thrown value to classify. Anything can be thrown in
 *     JavaScript, so this takes `unknown` rather than `Error`.
 * @returns The `error.type` attribute value.
 */
export function resolveErrorType(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('errorType' in error && typeof error.errorType === 'string') {
      return error.errorType;
    }
    if ('status' in error && typeof error.status === 'number') {
      return String(error.status);
    }
  }
  if (error instanceof Error) {
    return error.name || error.constructor.name;
  }
  return String(error);
}
