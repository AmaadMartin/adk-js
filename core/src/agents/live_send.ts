/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {createEvent} from '../events/event.js';
import {BaseLlmConnection} from '../models/base_llm_connection.js';

import {InvocationContext} from './invocation_context.js';
import {LiveRequest} from './live_request_queue.js';

function hasFunctionResponse(content: Content): boolean {
  return !!content.parts?.some((part) => part.functionResponse);
}

/**
 * Whether the send loop turns this request into a user-content session event.
 *
 * A closing, partial, or function-response request never produces one, so a
 * state delta riding on it needs its own content-less event instead.
 */
function createsContentEvent(liveRequest: LiveRequest): boolean {
  return (
    !!liveRequest.content &&
    !liveRequest.close &&
    !liveRequest.partial &&
    !hasFunctionResponse(liveRequest.content)
  );
}

/**
 * Appends a `user`-authored event to the session behind the invocation.
 *
 * The live send loop persists what the client sends, which the receive loop
 * never sees. An invocation running without a session service — an agent
 * driven directly rather than through a `Runner` — has nowhere to persist to.
 */
async function appendLiveUserEvent(
  invocationContext: InvocationContext,
  content: Content | undefined,
  stateDelta: Record<string, unknown> | undefined,
): Promise<void> {
  const sessionService = invocationContext.sessionService;
  if (!sessionService) {
    return;
  }
  await sessionService.appendEvent({
    session: invocationContext.session,
    event: createEvent({
      invocationId: invocationContext.invocationId,
      author: 'user',
      content,
      actions: stateDelta ? {stateDelta} : undefined,
    }),
  });
}

/**
 * Sends one queued live request to the model and persists what it carries.
 *
 * Mirrors `BaseLlmFlow._send_to_model` in adk-python: a state delta is applied
 * first so it survives a closing or partial request, the realtime signals are
 * mutually exclusive, and content is persisted once before it reaches the
 * model.
 */
export async function dispatchLiveRequest(
  invocationContext: InvocationContext,
  connection: BaseLlmConnection,
  liveRequest: LiveRequest,
): Promise<void> {
  const contentEventCreated = createsContentEvent(liveRequest);

  if (liveRequest.stateDelta && !contentEventCreated) {
    await appendLiveUserEvent(
      invocationContext,
      undefined,
      liveRequest.stateDelta,
    );
  }

  if (liveRequest.close) {
    await connection.close();
    return;
  }

  if (liveRequest.activityStart) {
    await connection.sendActivityStart?.();
  } else if (liveRequest.activityEnd) {
    await connection.sendActivityEnd?.();
  } else if (liveRequest.audioStreamEnd) {
    await connection.sendAudioStreamEnd?.();
  } else if (liveRequest.blob) {
    await connection.sendRealtime(liveRequest.blob);
  }

  const content = liveRequest.content;
  if (!content) {
    return;
  }
  if (content.parts?.some((part) => part.functionCall)) {
    throw new Error('User message cannot contain function calls.');
  }
  if (!content.role && !hasFunctionResponse(content)) {
    content.role = 'user';
  }
  if (contentEventCreated) {
    await appendLiveUserEvent(
      invocationContext,
      content,
      liveRequest.stateDelta,
    );
  }
  await connection.sendContent(content, {partial: liveRequest.partial});
}
