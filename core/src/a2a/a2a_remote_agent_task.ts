/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {Content as GenAIContent} from '@google/genai';
import {InvocationContext} from '../agents/invocation_context.js';
import {
  Event as AdkEvent,
  createEvent,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../tools/finish_task_tool.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';

/**
 * Builds the failing `finish_task` function response a delegating agent writes
 * so its coordinator sees the task end rather than waiting on it.
 */
export function createFinishTaskFailureEvent(
  ctx: InvocationContext,
  agentName: string,
  errorMessage: string,
): AdkEvent {
  return createEvent({
    author: agentName,
    invocationId: ctx.invocationId,
    branch: ctx.branch,
    isolationScope: ctx.isolationScope,
    errorMessage,
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: FINISH_TASK_TOOL_NAME,
            response: {result: FINISH_TASK_ERROR_RESULT},
          },
        },
      ],
    },
  });
}

/** Parameters for {@link createTaskFailureEvents}. */
export interface TaskFailureEventsParams {
  /** What the peer reported, or a stand-in when it reported nothing. */
  errorText: string;
  ctx: InvocationContext;
  agentName: string;
  /** The A2A task that failed. */
  taskId: string;
  /** The request that produced the failure, recorded on the error event. */
  request?: Message;
}

/**
 * Builds the pair of events a failed or cancelled remote task produces: the
 * error itself, then the `finish_task` failure that releases the coordinator.
 */
export function createTaskFailureEvents({
  errorText,
  ctx,
  agentName,
  taskId,
  request,
}: TaskFailureEventsParams): [AdkEvent, AdkEvent] {
  const errorMessage = `Remote A2A task failed: ${errorText}`;
  const customMetadata: Record<string, unknown> = {
    [AdkMetadataKeys.ERROR]: errorMessage,
    [AdkMetadataKeys.TASK_ID]: taskId,
  };
  if (request) {
    customMetadata[AdkMetadataKeys.REQUEST] = request;
  }
  const errorEvent = createEvent({
    author: agentName,
    invocationId: ctx.invocationId,
    branch: ctx.branch,
    isolationScope: ctx.isolationScope,
    errorMessage,
    customMetadata,
  });
  const finishEvent = createFinishTaskFailureEvent(
    ctx,
    agentName,
    errorMessage,
  );
  return [errorEvent, finishEvent];
}

/** The joined text of a content's text parts, or `undefined` when it has none. */
export function textFromContent(
  content: GenAIContent | undefined,
): string | undefined {
  const texts = (content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text));
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** The event that hands control back to the delegating coordinator. */
export function createEndOfAgentEvent(
  ctx: InvocationContext,
  agentName: string,
): AdkEvent {
  const event = createEvent({
    author: agentName,
    invocationId: ctx.invocationId,
    branch: ctx.branch,
    isolationScope: ctx.isolationScope,
  });
  event.actions.endOfAgent = true;
  return event;
}

/**
 * The arguments of the newest `finish_task` call in the session.
 *
 * The peer's terminal function response names the call it answers, so when
 * `completedEvent` carries an id the search matches on it. Otherwise the
 * newest call wins.
 *
 * @param session - The session to search.
 * @param isolationScope - When set, only events in that scope are considered.
 * @param completedEvent - The terminal `finish_task` response, if any.
 * @returns The call arguments, or `undefined` when no call matches.
 */
export function findFinishTaskArgsFromHistory(
  session: Session,
  isolationScope?: string,
  completedEvent?: AdkEvent,
): Record<string, unknown> | undefined {
  const matchingCallId = completedEvent
    ? getFunctionResponses(completedEvent).find(
        (response) => response.name === FINISH_TASK_TOOL_NAME,
      )?.id
    : undefined;

  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (isolationScope && event.isolationScope !== isolationScope) {
      continue;
    }
    for (const call of getFunctionCalls(event)) {
      if (call.name !== FINISH_TASK_TOOL_NAME) {
        continue;
      }
      if (matchingCallId === undefined || call.id === matchingCallId) {
        return {...call.args};
      }
    }
  }
  return undefined;
}
