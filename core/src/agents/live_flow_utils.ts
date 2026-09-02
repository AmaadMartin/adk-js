/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Behavior} from '@google/genai';

import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {logger} from '../utils/logger.js';
import {Task} from '../utils/task.js';
import {AudioCacheManager} from './audio_cache_manager.js';
import {InvocationContext} from './invocation_context.js';

/**
 * How long a live run waits for a background tool task to honor cancellation
 * before it gives up on that task.
 */
const TOOL_SHUTDOWN_TIMEOUT_MS = 1000;

/**
 * Cancels the background tool tasks the current live run started.
 *
 * A live run starts two kinds of tool in the background: streaming tools, in
 * `activeStreamingTools`, and non-blocking tools, in
 * `activeNonBlockingToolTasks`. Neither is tied to the lifetime of the run
 * that started it, so a tool outlives its agent and keeps writing function
 * responses to a live request queue that now belongs to somebody else.
 *
 * Cancellation is best effort. A task that does not stop within
 * {@link TOOL_SHUTDOWN_TIMEOUT_MS} is logged and left behind rather than
 * stalling the caller's teardown.
 *
 * @param invocationContext The invocation context holding both registries.
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
  for (const [name, task] of Object.entries(
    invocationContext.activeNonBlockingToolTasks ?? {},
  )) {
    tasks.push([name, task]);
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
  if (invocationContext.activeNonBlockingToolTasks) {
    invocationContext.activeNonBlockingToolTasks = {};
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
 * Flushes the audio caches that a control-event response ends.
 *
 * An `interrupted` response flushes the model's audio, because the model has
 * stopped while the user keeps speaking. A `turnComplete` response flushes
 * both. Any other response flushes nothing.
 *
 * @param invocationContext The current invocation context.
 * @param llmResponse The response received from the live connection.
 * @param audioCacheManager The audio cache manager of this live flow.
 * @return The events created from the flushed caches.
 */
export function handleControlEventFlush(
  invocationContext: InvocationContext,
  llmResponse: LlmResponse,
  audioCacheManager: AudioCacheManager,
): Promise<Event[]> {
  if (llmResponse.interrupted) {
    return audioCacheManager.flushCaches(invocationContext, {
      flushUserAudio: false,
      flushModelAudio: true,
    });
  }
  if (llmResponse.turnComplete) {
    return audioCacheManager.flushCaches(invocationContext);
  }
  return Promise.resolve([]);
}

/** One step of {@link mergeEventStreams}: which stream produced it. */
type MergeStep =
  | {readonly from: 'primary'; readonly result: IteratorResult<Event, void>}
  | {
      readonly from: 'screened';
      readonly result: IteratorResult<Event, unknown>;
    };

/**
 * Yields the events of `primary` and of `screened` as each arrives, and ends
 * when `primary` ends.
 *
 * The live flow receives model events on one path and screens the user's typed
 * text on another. A blocked typed message never reaches the model, so no
 * server message follows it; racing the two paths is what delivers that event
 * to the caller instead of parking it behind a message that never comes.
 *
 * @param primary The receive loop. Its end ends the merged stream, and its
 *     error propagates.
 * @param screened Events the send loop produced.
 */
export async function* mergeEventStreams(
  primary: AsyncGenerator<Event, void, void>,
  screened: AsyncQueue<Event>,
): AsyncGenerator<Event, void, void> {
  const screenedIterator = screened[Symbol.asyncIterator]();
  let primaryNext = primary.next();
  let screenedNext: Promise<IteratorResult<Event, unknown>> | undefined =
    screenedIterator.next();

  try {
    while (true) {
      const candidates: Array<Promise<MergeStep>> = [
        primaryNext.then((result) => ({from: 'primary', result}) as const),
      ];
      if (screenedNext) {
        candidates.push(
          screenedNext.then((result) => ({from: 'screened', result}) as const),
        );
      }
      const winner = await Promise.race(candidates);

      if (winner.from === 'screened') {
        if (winner.result.done) {
          screenedNext = undefined;
          continue;
        }
        yield winner.result.value;
        screenedNext = screenedIterator.next();
        continue;
      }

      if (winner.result.done) {
        // Hand over a screened event that landed in the same tick, then stop.
        const buffered = screenedNext
          ? await Promise.race([screenedNext, Promise.resolve(undefined)])
          : undefined;
        if (buffered && !buffered.done) {
          yield buffered.value;
        }
        return;
      }
      yield winner.result.value;
      primaryNext = primary.next();
    }
  } finally {
    // Close the receive loop without waiting on it: when the caller walks
    // away it is usually parked on a server message that is not coming.
    void primary.return(undefined).catch(() => undefined);
  }
}
