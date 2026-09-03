/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {Event as AdkEvent} from '../events/event.js';
import {A2AEvent, createTask} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';

/**
 * Hooks that can observe and rewrite what an execution publishes.
 *
 * Unlike the executor's callbacks, an interceptor decides what reaches the
 * event bus: it can replace the request context, expand or drop a converted
 * event, and rewrite the terminal event.
 */
export interface ExecuteInterceptor {
  /**
   * Runs before the agent starts. The returned context replaces the incoming
   * one for the rest of the execution.
   */
  beforeAgent?: (ctx: RequestContext) => Promise<RequestContext>;

  /**
   * Runs after an ADK event is converted to an A2A event. Return an array to
   * publish several events in its place, or `undefined` to drop it.
   */
  afterEvent?: (
    ctx: ExecutorContext,
    event: A2AEvent,
    adkEvent: AdkEvent,
  ) => Promise<A2AEvent | A2AEvent[] | undefined>;

  /**
   * Runs once the terminal event is prepared, before it is published. The
   * returned event replaces it.
   */
  afterAgent?: (
    ctx: ExecutorContext,
    finalEvent: TaskStatusUpdateEvent,
  ) => Promise<TaskStatusUpdateEvent>;
}

/**
 * Returns the values an executor-ready A2A request guarantees.
 *
 * @throws {Error} When the request carries no message, task id or context id.
 */
export function requireRequestContext(ctx: RequestContext): {
  taskId: string;
  contextId: string;
} {
  if (!ctx.userMessage) {
    throw new Error('message not provided');
  }
  if (!ctx.taskId) {
    throw new Error('A2A request must have a task ID');
  }
  if (!ctx.contextId) {
    throw new Error('A2A request must have a context ID');
  }

  return {taskId: ctx.taskId, contextId: ctx.contextId};
}

/**
 * Publishes the initial "submitted" signal for a brand-new task, and nothing
 * for a task the client already holds.
 *
 * The signal is a `Task` rather than a submitted status update because the
 * `@a2a-js/sdk` result manager warns `Received status update for unknown task`
 * for any status update that arrives before the task exists. adk-python emits
 * a status update here on the a2a 0.3.x wire; this is the shape that SDK
 * accepts.
 */
export function enqueueSubmittedSignal(
  ctx: RequestContext,
  eventBus: ExecutionEventBus,
): void {
  if (ctx.task) {
    return;
  }

  eventBus.publish(
    createTask({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      message: ctx.userMessage,
    }),
  );
}

/**
 * Runs the `beforeAgent` hooks in order, each seeing the previous one's result.
 */
export async function executeBeforeAgentInterceptors(
  ctx: RequestContext,
  interceptors: ExecuteInterceptor[] = [],
): Promise<RequestContext> {
  let current = ctx;
  for (const interceptor of interceptors) {
    if (interceptor.beforeAgent) {
      current = await interceptor.beforeAgent(current);
    }
  }

  return current;
}

/**
 * Runs the `afterEvent` hooks in order over the events produced so far.
 *
 * Each hook sees every surviving event and may replace it with none, one or
 * many. Once every event is dropped, later hooks have nothing left to see.
 */
export async function executeAfterEventInterceptors(
  a2aEvent: A2AEvent,
  executorContext: ExecutorContext,
  adkEvent: AdkEvent,
  interceptors: ExecuteInterceptor[] = [],
): Promise<A2AEvent[]> {
  let events: A2AEvent[] = [a2aEvent];
  for (const interceptor of interceptors) {
    const afterEvent = interceptor.afterEvent;
    if (!afterEvent) {
      continue;
    }
    const next: A2AEvent[] = [];
    for (const event of events) {
      const result = await afterEvent(executorContext, event, adkEvent);
      if (result === undefined) {
        continue;
      }
      next.push(...(Array.isArray(result) ? result : [result]));
    }
    events = next;
  }

  return events;
}

/**
 * Runs the `afterAgent` hooks in reverse order, so the interceptor registered
 * first has the last word on the terminal event.
 */
export async function executeAfterAgentInterceptors(
  executorContext: ExecutorContext,
  finalEvent: TaskStatusUpdateEvent,
  interceptors: ExecuteInterceptor[] = [],
): Promise<TaskStatusUpdateEvent> {
  let event = finalEvent;
  for (const interceptor of [...interceptors].reverse()) {
    if (interceptor.afterAgent) {
      event = await interceptor.afterAgent(executorContext, event);
    }
  }

  return event;
}
