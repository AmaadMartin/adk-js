/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, CreateEventParams, Event} from '../events/event.js';
import {errorName} from './utils/retry_utils.js';

export interface NodeErrorEvent extends Event {
  readonly isNodeError: true;

  errorType: string;

  attemptCount: number;
}

export interface CreateNodeErrorEventParams extends CreateEventParams {
  error: unknown;

  attemptCount?: number;
}

export function isNodeErrorEvent(event: Event): event is NodeErrorEvent {
  return 'isNodeError' in event && event.isNodeError === true;
}

const reportedInvocationIds = new WeakMap<object, string>();

export function claimNodeErrorReport(
  error: unknown,
  invocationId: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return true;
  }
  if (reportedInvocationIds.get(error) === invocationId) {
    return false;
  }
  reportedInvocationIds.set(error, invocationId);
  return true;
}

/**
 * Whether this failure has already been reported in this invocation, without
 * claiming it.
 *
 * The node runner asks before it reports an attempt: a failure that travelled
 * up from a nested node was recorded where it happened, and must not be
 * recorded again at every level it passes through. It claims separately, and
 * only for the attempt it stops retrying on, so a retried failure still reports
 * each attempt even when the node throws one error object every time.
 */
export function isNodeErrorReported(
  error: unknown,
  invocationId: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return reportedInvocationIds.get(error) === invocationId;
}

export function createNodeErrorEvent(
  params: CreateNodeErrorEventParams,
): NodeErrorEvent {
  const {error, attemptCount, ...eventParams} = params;
  return {
    ...createEvent(eventParams),
    isNodeError: true,
    errorType: errorName(error),
    errorCode: eventParams.errorCode ?? errorCodeOf(error),
    errorMessage: eventParams.errorMessage ?? errorMessageOf(error),
    attemptCount: attemptCount ?? 1,
  };
}

/**
 * The code reported for a failure, most specific first: the API's own canonical
 * status (`PERMISSION_DENIED`), then a `code` the error carries, then the
 * error's class name.
 *
 * The status wins so a structured code from the service reaches the client
 * rather than the transport's class name, and it counts only as a string — an
 * HTTP client's numeric `.status` is a code, not a status. `UNKNOWN_ERROR` is
 * left for a thrown value that is neither an `Error` nor carries either field.
 */
function errorCodeOf(error: unknown): string {
  const status = (error as {status?: unknown} | null | undefined)?.status;
  if (typeof status === 'string') {
    return status;
  }
  const code = (error as {code?: unknown} | null | undefined)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  if (error instanceof Error) {
    return errorName(error);
  }
  return 'UNKNOWN_ERROR';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
