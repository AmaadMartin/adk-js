/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Behavior} from '@google/genai';

import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {logger} from '../utils/logger.js';
import {Task} from '../utils/task.js';
import {InvocationContext} from './invocation_context.js';

/**
 * How long a live run waits for a background tool task to honor cancellation
 * before it gives up on that task.
 */
const TOOL_SHUTDOWN_TIMEOUT_MS = 1000;

/**
 * Cancels the streaming tool tasks the current live run started.
 *
 * Nothing tied a streaming tool to the lifetime of the run that started it, so
 * a tool outlives its agent and keeps writing function responses to a live
 * request queue that now belongs to somebody else.
 *
 * Cancellation is best effort. A task that does not stop within
 * {@link TOOL_SHUTDOWN_TIMEOUT_MS} is logged and left behind rather than
 * stalling the caller's teardown.
 *
 * @param invocationContext The invocation context holding the registry.
 */
export async function stopBackgroundToolTasks(
  invocationContext: InvocationContext,
): Promise<void> {
  const tasks: Array<[string, Task<void>]> = [];
  for (const [name, active] of Object.entries(
    invocationContext.activeStreamingTools ?? {},
  )) {
    if (active.task) {
      tasks.push([name, active.task]);
    }
  }

  const pending = tasks.filter(([, task]) => !task.done());
  if (pending.length === 0) {
    return;
  }

  logger.debug(`Stopping ${pending.length} background tool task(s).`);
  for (const [, task] of pending) {
    task.cancel();
  }
  await settleWithin(
    pending.map(([, task]) => task.promise),
    TOOL_SHUTDOWN_TIMEOUT_MS,
  );
  for (const [name, task] of pending) {
    if (!task.done()) {
      logger.warn(
        `Tool task '${name}' ignored cancellation and outlives its agent.`,
      );
    }
  }

  // The run is over, so nothing it registered is current any more, whether or
  // not the task honored the cancellation. Releasing the streams matters most:
  // the send loop copies every live request into each registered stream, so
  // one left behind grows for as long as the session lasts.
  if (invocationContext.activeStreamingTools) {
    invocationContext.activeStreamingTools = {};
  }
}

/**
 * Waits for every promise to settle, or for `timeoutMs` to elapse, whichever
 * happens first. The timer is cleared either way, so a caller that returns
 * early does not hold the event loop open.
 */
async function settleWithin(
  promises: Array<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(promises), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Declares every streaming or response-scheduling tool `NON_BLOCKING`.
 *
 * Such a tool answers asynchronously, and `NON_BLOCKING` is the only behavior
 * for which the Live API accepts an asynchronous function response. A tool
 * that answers synchronously keeps whatever behavior it already declared.
 *
 * @param llmRequest The request whose tool declarations are marked in place.
 */
export function markLiveAsyncToolsNonBlocking(llmRequest: LlmRequest): void {
  for (const geminiTool of llmRequest.config?.tools ?? []) {
    if (!('functionDeclarations' in geminiTool)) {
      continue;
    }
    for (const declaration of geminiTool.functionDeclarations ?? []) {
      if (!declaration.name) {
        continue;
      }
      const tool = llmRequest.toolsDict[declaration.name];
      if (!tool) {
        continue;
      }
      if (tool.responseScheduling !== undefined || tool.isStreaming) {
        declaration.behavior = Behavior.NON_BLOCKING;
      }
    }
  }
}

/**
 * Drains `source` into `queue`, closing it when the source ends and failing it
 * with whatever the source threw.
 *
 * The live flow puts the model's events and the send loop's screened events on
 * one queue. A blocked typed message never reaches the model, so no server
 * message follows it; sharing the queue is what delivers that event to the
 * caller instead of parking it behind a message that never comes.
 * {@link AsyncQueue} hands over every buffered item before the end or the
 * error, so nothing the source produced is lost either way.
 *
 * @param source The receive loop.
 * @param queue The queue the flow yields from.
 * @return A promise that settles when the source ends. It never rejects: the
 *     error reaches the consumer through the queue.
 */
export async function pumpEventsInto(
  source: AsyncGenerator<Event, void, void>,
  queue: AsyncQueue<Event>,
): Promise<void> {
  try {
    for await (const event of source) {
      queue.push(event);
    }
    queue.close();
  } catch (error: unknown) {
    queue.fail(error);
  }
}
