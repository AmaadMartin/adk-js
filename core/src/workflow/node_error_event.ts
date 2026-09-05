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
 * The code reported for a failure: a `code` the error carries, otherwise its
 * class name. `UNKNOWN_ERROR` is left for a thrown value that is neither an
 * `Error` nor carries a code.
 *
 * The class-name rung is what `google/adk-python` reports
 * (`workflow/_node_runner.py` builds its error event with
 * `error_code=type(e).__name__`). The `code` rung is adk-js's own and stays in
 * front of it, since an error that names its own failure says more than the
 * class that carried it.
 */
function errorCodeOf(error: unknown): string {
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
