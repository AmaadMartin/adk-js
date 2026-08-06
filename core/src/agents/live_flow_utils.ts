/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {LlmResponse} from '../models/llm_response.js';
import {AudioCacheManager} from './audio_cache_manager.js';
import {InvocationContext} from './invocation_context.js';
import {LiveRequest} from './live_request_queue.js';

/**
 * Forwards a drained {@link LiveRequest} to every active streaming tool so that
 * streaming tools observe the user's live input.
 *
 * The request is forwarded as-is; it is not mutated. Tools without a `stream`
 * are skipped. A no-op when there are no active streaming tools.
 *
 * @param invocationContext The current invocation context.
 * @param liveRequest The request drained from the live request queue.
 */
export function fanOutLiveRequest(
  invocationContext: InvocationContext,
  liveRequest: LiveRequest,
): void {
  const activeStreamingTools = invocationContext.activeStreamingTools;
  if (!activeStreamingTools) {
    return;
  }
  for (const activeStreamingTool of Object.values(activeStreamingTools)) {
    activeStreamingTool.stream?.send(liveRequest);
  }
}

/**
 * Persists a live request's user text content and `stateDelta` to the session,
 * mirroring non-live mode.
 *
 * State changes ride on the user content event when one is created; otherwise a
 * standalone content-less event applies them, so the delta takes effect even
 * when the request carries no content or a partial / function-response turn.
 * The user content event is skipped for partial turns, function responses, and
 * closing requests. Persistence goes through
 * `invocationContext.sessionService.appendEvent`, which applies `stateDelta` to
 * the session state.
 *
 * @param invocationContext The current invocation context.
 * @param liveRequest The request drained from the live request queue.
 * @throws {Error} If the content contains any function call.
 */
export async function persistLiveRequest(
  invocationContext: InvocationContext,
  liveRequest: LiveRequest,
): Promise<void> {
  const content = liveRequest.content;
  const isFunctionResponse = !!content?.parts?.some(
    (part) => part.functionResponse,
  );
  // State changes ride on the user content event when one is created below.
  const contentEventCreated = !!(
    content &&
    !liveRequest.close &&
    !liveRequest.partial &&
    !isFunctionResponse
  );

  if (liveRequest.stateDelta && !contentEventCreated) {
    await invocationContext.sessionService?.appendEvent({
      session: invocationContext.session,
      event: createEvent({
        invocationId: invocationContext.invocationId,
        author: 'user',
        actions: createEventActions({stateDelta: liveRequest.stateDelta}),
      }),
    });
  }

  if (!content) {
    return;
  }

  if (content.parts?.some((part) => part.functionCall)) {
    throw new Error('User message cannot contain function calls.');
  }

  if (!isFunctionResponse && !content.role) {
    content.role = 'user';
  }

  if (contentEventCreated) {
    await invocationContext.sessionService?.appendEvent({
      session: invocationContext.session,
      event: createEvent({
        invocationId: invocationContext.invocationId,
        author: 'user',
        content,
        actions: liveRequest.stateDelta
          ? createEventActions({stateDelta: liveRequest.stateDelta})
          : createEventActions(),
      }),
    });
  }
}

/**
 * Flushes audio caches in response to a control-event {@link LlmResponse}.
 *
 * An `interrupted` response flushes model audio only; a `turnComplete` response
 * flushes both user and model audio. Any other response is a no-op.
 *
 * @param invocationContext The current invocation context.
 * @param llmResponse The control-event response from the live stream.
 * @param audioCacheManager The audio cache manager for this live flow.
 * @returns The events created from the flushed caches.
 */
export async function handleControlEventFlush(
  invocationContext: InvocationContext,
  llmResponse: LlmResponse,
  audioCacheManager: AudioCacheManager,
): Promise<Event[]> {
  if (llmResponse.interrupted) {
    // The user interrupted the model, so only the model audio can be flushed.
    return audioCacheManager.flushCaches(invocationContext, {
      flushUserAudio: false,
      flushModelAudio: true,
    });
  }
  if (llmResponse.turnComplete) {
    return audioCacheManager.flushCaches(invocationContext, {
      flushUserAudio: true,
      flushModelAudio: true,
    });
  }
  return [];
}
