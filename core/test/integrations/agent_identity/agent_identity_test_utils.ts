/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, createEvent} from '@google/adk';
import {expect} from 'vitest';
import {AgentIdentityContext} from '../../../src/integrations/agent_identity/credentials_utils.js';

/** Name of the long-running function call ADK uses to request consent. */
export const EUC_NAME = 'adk_request_credential';

/** Builds an event carrying a single function call. */
export function functionCallEvent(
  id: string,
  name: string,
  args?: Record<string, unknown>,
): Event {
  return createEvent({content: {parts: [{functionCall: {id, name, args}}]}});
}

/** Builds an event carrying a single function response. */
export function functionResponseEvent(id: string, name: string): Event {
  return createEvent({
    content: {parts: [{functionResponse: {id, name, response: {}}}]},
  });
}

/**
 * Builds the event pair ADK leaves behind once the end user completed consent
 * for `functionCallId`, using the snake_case arguments adk-js actually writes.
 */
export function consentCompletedEvents(functionCallId: string): Event[] {
  return [
    functionCallEvent('auth-req-1', EUC_NAME, {
      'function_call_id': functionCallId,
    }),
    functionResponseEvent('auth-req-1', EUC_NAME),
  ];
}

/** Builds a context carrying a session with `events`. */
export function contextWithEvents(
  events: Event[],
  functionCallId = 'call-123',
): AgentIdentityContext {
  return {
    userId: 'user',
    functionCallId,
    invocationContext: {session: {events}},
  };
}

/** Awaits `promise` and returns the `Error` it rejected with. */
export async function captureError(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof Error)) {
    expect.fail('expected the call to reject with an Error');
  }
  return error;
}

/** Returns the `Error` that `error` was chained from. */
export function causeOf(error: Error): Error {
  const cause = error.cause;
  if (!(cause instanceof Error)) {
    expect.fail('expected the error to carry an Error cause');
  }
  return cause;
}
