/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, Message} from '@a2a-js/sdk';
import {ClientCallContext} from '@a2a-js/sdk/client';
import {Part as GenAIPart} from '@google/genai';
import {InvocationContext, requireAgent} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {A2AEvent, isMessage} from './a2a_event.js';
import {
  A2A_SESSION_STATE_CONTEXT_KEY,
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  A2ARequestParameters,
} from './a2a_remote_agent_config.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

export interface UserFunctionCall {
  response: AdkEvent;
  taskId: string;
  contextId: string;
}

/**
 * Collects the HTTP headers that the card request interceptors contribute.
 *
 * @param interceptors - The configured card request interceptors.
 * @param ctx - The current invocation context.
 * @returns The merged headers, or `undefined` when no header was contributed.
 *   Headers merge in list order, so a later interceptor wins a key conflict.
 */
export async function runBeforeCardRequestInterceptors(
  interceptors: A2ACardRequestInterceptor[],
  ctx: InvocationContext,
): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = {};
  for (const interceptor of interceptors) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const config = await interceptor.beforeRequest(ctx);
    Object.assign(headers, config.headers);
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Runs the request interceptors in list order before the request is sent.
 *
 * @param interceptors - The configured request interceptors.
 * @param ctx - The current invocation context.
 * @param request - The A2A message about to be sent.
 * @returns The message to send and the accumulated parameters. When an
 *   interceptor returns an ADK event, that event is returned instead of a
 *   message and the remaining interceptors do not run.
 */
export async function runBeforeRequestInterceptors(
  interceptors: A2ARequestInterceptor[],
  ctx: InvocationContext,
  request: Message,
): Promise<[Message | AdkEvent, A2ARequestParameters]> {
  let params: A2ARequestParameters = {
    clientCallContext: ClientCallContext.create(
      A2A_SESSION_STATE_CONTEXT_KEY.set(ctx.session.state),
    ),
  };

  let message = request;
  for (const interceptor of interceptors) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const [result, nextParams] = await interceptor.beforeRequest(
      ctx,
      message,
      params,
    );
    params = nextParams;
    if (!isMessage(result)) {
      return [result, params];
    }
    message = result;
  }

  return [message, params];
}

/**
 * Runs the request interceptors in reverse list order on a converted event.
 *
 * @param interceptors - The configured request interceptors.
 * @param ctx - The current invocation context.
 * @param response - The raw A2A response the event was converted from.
 * @param event - The converted ADK event.
 * @returns The event to emit, or `undefined` once an interceptor drops it.
 */
export async function runAfterRequestInterceptors(
  interceptors: A2ARequestInterceptor[],
  ctx: InvocationContext,
  response: A2AEvent,
  event: AdkEvent,
): Promise<AdkEvent | undefined> {
  let current = event;
  for (const interceptor of [...interceptors].reverse()) {
    if (!interceptor.afterRequest) {
      continue;
    }
    const result = await interceptor.afterRequest(ctx, response, current);
    if (!result) {
      return undefined;
    }
    current = result;
  }

  return current;
}

/**
 * Returns a UserFunctionCall when the event at `index` contains a
 * FunctionResponse that can be traced back to a preceding FunctionCall event.
 *
 * @param session - The session whose event history to inspect.
 * @param index - Index of the candidate event to examine.
 * @returns The matching `UserFunctionCall`, or `undefined` if the event at
 *   `index` is not a user function-response event or has no preceding call.
 */
export function getUserFunctionCallAt(
  session: Session,
  index: number,
): UserFunctionCall | undefined {
  const events = session.events;
  if (index < 0 || index >= events.length) {
    return undefined;
  }

  const candidate = events[index];
  if (candidate.author !== 'user') {
    return undefined;
  }

  const fnCallId = getFunctionResponseCallId(candidate);
  if (!fnCallId) {
    return undefined;
  }

  for (let i = index - 1; i >= 0; i--) {
    const request = events[i];
    if (!isFunctionCallEvent(request, fnCallId)) {
      continue;
    }

    const metadata = request.customMetadata || {};
    const taskId = (metadata[AdkMetadataKeys.TASK_ID] as string) || '';
    const contextId = (metadata[AdkMetadataKeys.CONTEXT_ID] as string) || '';

    return {
      response: candidate,
      taskId,
      contextId,
    };
  }

  return undefined;
}

/**
 * Checks if an event contains a function call with the given ID.
 *
 * @param event - The event to inspect.
 * @param callId - The function call ID to look for.
 * @returns `true` if a part in the event has a matching `functionCall.id`.
 */
export function isFunctionCallEvent(event: AdkEvent, callId: string): boolean {
  if (!event || !event.content || !event.content.parts) {
    return false;
  }

  return event.content.parts.some(
    (part: GenAIPart) => part.functionCall && part.functionCall.id === callId,
  );
}

/**
 * Finds the first part with a FunctionResponse and returns the call ID.
 *
 * @param event - The event to inspect.
 * @returns The `id` of the first FunctionResponse part, or `undefined` if
 *   none is found.
 */
export function getFunctionResponseCallId(event: AdkEvent): string | undefined {
  if (!event || !event.content || !event.content.parts) {
    return undefined;
  }

  const responsePart = event.content.parts.find(
    (part: GenAIPart) => part.functionResponse,
  );

  return responsePart?.functionResponse?.id;
}

/**
 * Returns A2A content parts for all events not yet seen by the remote agent,
 * along with the A2A context ID found in the most recent remote agent event.
 *
 * @param ctx - The current invocation context, used to identify the remote
 *   agent's authored events.
 * @param session - The local session whose event history to diff.
 * @returns An object with the missing `parts` and an optional `contextId`.
 */
export function toMissingRemoteSessionParts(
  ctx: InvocationContext,
  session: Session,
): {parts: A2APart[]; contextId?: string} {
  const events = session.events;
  let contextId: string | undefined = undefined;
  let lastRemoteResponseIndex = -1;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author === requireAgent(ctx).name) {
      lastRemoteResponseIndex = i;
      const metadata = event.customMetadata || {};
      contextId = metadata[AdkMetadataKeys.CONTEXT_ID] as string;
      break;
    }
  }

  const missingParts: A2APart[] = [];

  for (let i = lastRemoteResponseIndex + 1; i < events.length; i++) {
    let event = events[i];
    if (event.author !== 'user' && event.author !== requireAgent(ctx).name) {
      event = presentAsUserMessage(ctx, event);
    }

    if (
      !event.content ||
      !event.content.parts ||
      event.content.parts.length === 0
    ) {
      continue;
    }

    const parts = toA2AParts(event.content.parts, event.longRunningToolIds);
    missingParts.push(...parts);
  }

  return {
    parts: missingParts,
    contextId,
  };
}

/**
 * Wraps an agent event as a user message so it can be sent as context to a
 * remote agent that only accepts user-role messages.
 *
 * @param ctx - The current invocation context.
 * @param agentEvent - The agent-authored event to reframe as a user message.
 * @returns A new event with `author: 'user'` whose parts summarise the
 *   original agent event's text, function calls, and function responses.
 */
export function presentAsUserMessage(
  ctx: InvocationContext,
  agentEvent: AdkEvent,
): AdkEvent {
  const event = createEvent({
    author: 'user',
    invocationId: ctx.invocationId,
  });

  if (!agentEvent.content || !agentEvent.content.parts) {
    return event;
  }

  const parts: GenAIPart[] = [{text: 'For context:'}];

  for (const part of agentEvent.content.parts) {
    if (part.thought) {
      continue;
    }

    if (part.text) {
      parts.push({
        text: `[${agentEvent.author}] said: ${part.text}`,
      });
    } else if (part.functionCall) {
      const call = part.functionCall;
      parts.push({
        text: `[${agentEvent.author}] called tool ${call.name} with parameters: ${JSON.stringify(call.args)}`,
      });
    } else if (part.functionResponse) {
      const resp = part.functionResponse;
      parts.push({
        text: `[${agentEvent.author}] ${resp.name} tool returned result: ${JSON.stringify(resp.response)}`,
      });
    } else {
      parts.push(part);
    }
  }

  if (parts.length > 1) {
    event.content = {
      role: 'user',
      parts,
    };
  }

  return event;
}
