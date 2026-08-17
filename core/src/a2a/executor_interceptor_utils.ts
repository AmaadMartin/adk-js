/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {Event as AdkEvent} from '../events/event.js';
import {A2AEvent} from './a2a_event.js';
import {ExecuteInterceptor} from './executor_config.js';
import {ExecutorContext} from './executor_context.js';

/**
 * Runs the `beforeAgent` hooks in registration order.
 *
 * @param requestContext - The incoming A2A request context.
 * @param interceptors - The configured interceptors, if any.
 * @returns The context returned by the last hook, or the input context when no
 *   hook runs.
 */
export async function runBeforeAgentInterceptors(
  requestContext: RequestContext,
  interceptors?: ExecuteInterceptor[],
): Promise<RequestContext> {
  let context = requestContext;

  for (const interceptor of interceptors ?? []) {
    if (interceptor.beforeAgent) {
      context = await interceptor.beforeAgent(context);
    }
  }

  return context;
}

/**
 * Runs the `afterEvent` hooks in registration order.
 *
 * Each hook is called once per event the previous hook produced. A hook may
 * replace an event, fan it out into several, or drop it by returning
 * `undefined`. Once every event is dropped the chain ends.
 *
 * @param a2aEvent - The converted event entering the chain.
 * @param executorContext - The context of the running A2A request.
 * @param adkEvent - The ADK event the A2A event was converted from.
 * @param interceptors - The configured interceptors, if any.
 * @returns The events to publish, in order.
 */
export async function runAfterEventInterceptors(
  a2aEvent: A2AEvent,
  executorContext: ExecutorContext,
  adkEvent: AdkEvent,
  interceptors?: ExecuteInterceptor[],
): Promise<A2AEvent[]> {
  let events: A2AEvent[] = [a2aEvent];

  for (const interceptor of interceptors ?? []) {
    if (!interceptor.afterEvent) {
      continue;
    }

    const nextEvents: A2AEvent[] = [];
    for (const event of events) {
      const result = await interceptor.afterEvent(
        executorContext,
        event,
        adkEvent,
      );
      if (result === undefined) {
        continue;
      }

      nextEvents.push(...(Array.isArray(result) ? result : [result]));
    }

    events = nextEvents;
    if (events.length === 0) {
      return [];
    }
  }

  return events;
}

/**
 * Runs the `afterAgent` hooks in reverse registration order.
 *
 * @param executorContext - The context of the running A2A request.
 * @param finalEvent - The terminal status event entering the chain.
 * @param interceptors - The configured interceptors, if any.
 * @returns The event returned by the last hook to run, or the input event when
 *   no hook runs.
 */
export async function runAfterAgentInterceptors(
  executorContext: ExecutorContext,
  finalEvent: TaskStatusUpdateEvent,
  interceptors?: ExecuteInterceptor[],
): Promise<TaskStatusUpdateEvent> {
  const chain = interceptors ?? [];
  let event = finalEvent;

  for (let i = chain.length - 1; i >= 0; i--) {
    const afterAgent = chain[i].afterAgent;
    if (afterAgent) {
      event = await afterAgent(executorContext, event);
    }
  }

  return event;
}
