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
 * Drops a claim so the same error object can be reported again.
 *
 * A node that retries throws the same error object on each attempt and owes
 * the stream one event per attempt. Releasing between attempts keeps that
 * possible, while an unreleased claim still stops an outer node — or
 * `Workflow.reportNodeError` — from repeating a failure it only propagated.
 */
export function releaseNodeErrorReport(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    reportedInvocationIds.delete(error);
  }
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

function errorCodeOf(error: unknown): string {
  // An API client's own canonical status ('PERMISSION_DENIED') is the most
  // specific code available. The string check matters: several HTTP clients
  // expose a numeric `status`, which is a status code, not a canonical status.
  const status = (error as {status?: unknown} | null | undefined)?.status;
  if (typeof status === 'string') {
    return status;
  }
  const code = (error as {code?: unknown} | null | undefined)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return 'UNKNOWN_ERROR';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
