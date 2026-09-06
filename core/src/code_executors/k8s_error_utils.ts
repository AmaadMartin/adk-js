/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reading the two error shapes `@kubernetes/client-node` raises.
 *
 * The generated API clients throw `ApiException`, which carries the response
 * body but no `reason` of its own, unlike Python's client. `Watch` throws a
 * plain `Error` carrying the status code instead. Both are matched
 * structurally, so a check still holds when the caller and the client library
 * resolve different copies of the package.
 */

import type {ApiException} from '@kubernetes/client-node';

/** HTTP status a Kubernetes API returns for an object that is not there. */
const NOT_FOUND_STATUS = 404;

/** A non-200 response reported by `Watch`, whose message is already the reason. */
type WatchHttpError = Error & {statusCode: number};

/** Returns whether `error` is an error raised by a generated API client. */
export function isApiException(error: unknown): error is ApiException<unknown> {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'number' &&
    'body' in error &&
    'headers' in error
  );
}

/** Returns whether `error` is a non-200 response reported by `Watch`. */
export function isWatchHttpError(error: unknown): error is WatchHttpError {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  );
}

/** Returns whether `error` reports that the object is not there. */
export function isNotFoundError(error: unknown): boolean {
  return isApiException(error) && error.code === NOT_FOUND_STATUS;
}

/**
 * Extracts a human-readable reason from a Kubernetes API error.
 *
 * The reason lives in `body`, which is a parsed object for a JSON response and
 * a string otherwise, so the parse is guarded.
 */
export function getApiErrorReason(err: ApiException<unknown>): string {
  try {
    const body: unknown =
      typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
    if (body && typeof body === 'object') {
      const {reason, message} = body as {reason?: string; message?: string};
      if (reason) {
        return reason;
      }
      if (message) {
        return message;
      }
    }
  } catch {
    // Body was not JSON; fall back to the exception message below.
  }
  return err.message || 'Unknown error';
}
