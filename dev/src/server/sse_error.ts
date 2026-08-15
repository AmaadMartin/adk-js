/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Details of the failure that ended a `/run_sse` stream. The keys are
 * snake_case for wire parity with the `adk-python` API server, which builds
 * this object by hand; a client parses one shape from either server.
 */
interface SseErrorDetails {
  error_type: string;
  error_message: string;
  timestamp: number;
  stacktrace?: string;
}

/** Payload of the final `data:` frame written when a `/run_sse` stream fails. */
export interface SseErrorPayload {
  error: string;
  error_details: SseErrorDetails;
}

/** Reported as the error type when the thrown value carries no usable name. */
const DEFAULT_ERROR_TYPE = 'Error';

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object, so a duck-typed throw can be read without `any`.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns `value` when it is a non-empty string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Builds the payload of the in-band error frame that ends a failed `/run_sse`
 * stream. It never throws, whatever was thrown.
 *
 * @param e The value the agent run threw.
 * @param includeStacktrace Whether to attach the stack trace. Only true under
 *   debug logging, so a server at the default level never sends a stack trace
 *   to a client.
 */
export function buildSseErrorPayload(
  e: unknown,
  includeStacktrace: boolean,
): SseErrorPayload {
  const record = asRecord(e);
  const errorType = nonEmptyString(record?.['name']) ?? DEFAULT_ERROR_TYPE;
  const errorMessage = e instanceof Error ? e.message : String(e);
  const stacktrace = includeStacktrace
    ? nonEmptyString(record?.['stack'])
    : undefined;

  return {
    error: `${errorType}: ${errorMessage}`,
    error_details: {
      error_type: errorType,
      error_message: errorMessage,
      // Epoch seconds, matching the `time.time()` the Python server sends.
      timestamp: Date.now() / 1000,
      ...(stacktrace !== undefined ? {stacktrace} : {}),
    },
  };
}
