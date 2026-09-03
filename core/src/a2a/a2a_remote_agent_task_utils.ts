/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Part as GenAIPart} from '@google/genai';
import {InvocationContext} from '../agents/invocation_context.js';
import {
  Event as AdkEvent,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {FINISH_TASK_TOOL_NAME} from '../tools/finish_task_tool.js';
import {
  peerRequestedCallIds,
  presentAsUserMessage,
  withoutCredentialParts,
} from './a2a_remote_agent_utils.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';
import {
  GenAIPartToA2APartConverter,
  toA2AParts,
} from './part_converter_utils.js';

/** Marks a part that carries what the end user typed. */
const IS_USER_INPUT_METADATA_KEY = 'is_user_input';

/** What {@link toTaskScopeA2AParts} needs to walk one task's history. */
export interface TaskHistoryOptions {
  /** The remote agent's name; its own events end the walk. */
  peerName: string;
  /** The function call id that delegated this task. */
  taskScope: string;
  /** Whether a stateless peer receives the whole scope on every request. */
  fullHistoryWhenStateless: boolean;
  /** Converts one genai part. Defaults to the standard conversion. */
  converter?: GenAIPartToA2APartConverter;
}

/** Whether the event answers a delegation to `peerName` or came from it. */
function isRemoteResponse(event: AdkEvent, peerName: string): boolean {
  if (
    event.author === peerName &&
    event.customMetadata?.[AdkMetadataKeys.RESPONSE]
  ) {
    return true;
  }
  // A synthesized function response named after the peer means the previous
  // delegation to it has completed.
  return getFunctionResponses(event).some((fr) => fr.name === peerName);
}

/** Whether the event carries the coordinator call that delegated this task. */
function isTaskTrigger(event: AdkEvent, taskScope: string): boolean {
  return getFunctionCalls(event).some((fc) => fc.id === taskScope);
}

/** Every function call id this agent itself issued inside the task scope. */
function remoteCallIds(
  events: AdkEvent[],
  peerName: string,
  taskScope: string,
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.isolationScope !== taskScope || event.author !== peerName) {
      continue;
    }
    for (const fc of getFunctionCalls(event)) {
      if (fc.id) {
        ids.add(fc.id);
      }
    }
  }
  return ids;
}

/**
 * Collects the events one task delegation may send, newest first.
 *
 * The walk is restricted to the task's isolation scope, so no other task's
 * data crosses the boundary, and it is bounded at one end by the coordinator's
 * triggering function call and at the other by the peer's own last reply.
 *
 * @throws {Error} When the scope names no triggering function call, which
 *   means the scope did not come from a function-call delegation.
 */
function collectScopedEvents(
  session: Session,
  options: TaskHistoryOptions,
): {events: AdkEvent[]; contextId?: string} {
  const {peerName, taskScope, fullHistoryWhenStateless} = options;
  const collected: AdkEvent[] = [];
  let contextId: string | undefined;
  let bounded = false;

  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (event.isolationScope !== taskScope) {
      // Anything outside the scope is another task's, except the coordinator
      // call that started this one; nothing older than that call is in scope.
      if (isTaskTrigger(event, taskScope)) {
        collected.push(event);
        bounded = true;
        break;
      }
      continue;
    }
    if (isRemoteResponse(event, peerName)) {
      contextId = event.customMetadata?.[AdkMetadataKeys.CONTEXT_ID] as
        | string
        | undefined;
      // A stateful peer already holds this history in its own session.
      if (!fullHistoryWhenStateless || contextId) {
        bounded = true;
        break;
      }
    }
    collected.push(event);
  }

  if (!bounded) {
    throw new Error(
      `RemoteA2AAgent '${peerName}' in task mode could not find the triggering` +
        ` FunctionCall for isolation scope '${taskScope}' in session history.` +
        ' Workflow path scopes are not supported.',
    );
  }
  return {events: collected.reverse(), contextId};
}

/**
 * Converts one part of a task-scope event, flattening a function response the
 * peer cannot resume.
 */
function toTaskScopeParts(
  part: GenAIPart,
  remoteIds: ReadonlySet<string>,
  options: TaskHistoryOptions,
): A2APart[] {
  const response = part.functionResponse;
  if (response && !(response.id && remoteIds.has(response.id))) {
    // The peer has no invocation to resume for a call it never made, and the
    // receiving runner rejects a function response next to its own history.
    return [
      {
        kind: 'text',
        text: `Tool ${response.name} returned: ${JSON.stringify(response.response)}`,
      },
    ];
  }
  return toA2AParts([part], [], options.converter);
}

/**
 * Builds the A2A parts one task delegation sends, along with the context id of
 * the peer's last reply.
 *
 * @throws {Error} When the isolation scope names no triggering function call.
 */
export function toTaskScopeA2AParts(
  ctx: InvocationContext,
  session: Session,
  options: TaskHistoryOptions,
): {parts: A2APart[]; contextId?: string} {
  const {events, contextId} = collectScopedEvents(session, options);
  const peerRequestedIds = peerRequestedCallIds(
    session.events,
    options.peerName,
  );
  const remoteIds = remoteCallIds(
    session.events,
    options.peerName,
    options.taskScope,
  );
  const parts: A2APart[] = [];

  for (const original of events) {
    // Scrub before presenting: presentAsUserMessage renders a call and its
    // arguments as text, which would embed a secret in a plain string.
    const content = withoutCredentialParts(original.content, peerRequestedIds);
    let event =
      content === original.content ? original : {...original, content};
    if (event.author !== 'user' && event.author !== options.peerName) {
      event = presentAsUserMessage(ctx, event);
    }

    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (
        call?.id &&
        call.id !== options.taskScope &&
        !remoteIds.has(call.id)
      ) {
        // A sibling call the coordinator aimed at another tool or agent.
        continue;
      }
      const converted = toTaskScopeParts(part, remoteIds, options);
      if (event.author === 'user') {
        for (const a2aPart of converted) {
          a2aPart.metadata = {
            ...a2aPart.metadata,
            [IS_USER_INPUT_METADATA_KEY]: true,
          };
        }
      }
      parts.push(...converted);
    }
  }

  return {parts, contextId};
}

/**
 * Finds the arguments of the `finish_task` call the peer made, so the task's
 * output can be promoted onto the terminal event.
 *
 * @param session - The session to search, newest event first.
 * @param isolationScope - Restricts the search to one task's events.
 * @param completedEvent - The terminal function response; when it carries an
 *   id, only the call with that id answers it.
 */
export function findFinishTaskArgsFromHistory(
  session: Session,
  isolationScope?: string,
  completedEvent?: AdkEvent,
): Record<string, unknown> | undefined {
  const matchingId = completedEvent
    ? getFunctionResponses(completedEvent).find(
        (fr) => fr.name === FINISH_TASK_TOOL_NAME,
      )?.id
    : undefined;

  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (isolationScope && event.isolationScope !== isolationScope) {
      continue;
    }
    for (const fc of getFunctionCalls(event)) {
      if (fc.name !== FINISH_TASK_TOOL_NAME) {
        continue;
      }
      if (matchingId === undefined || fc.id === matchingId) {
        return {...fc.args};
      }
    }
  }
  return undefined;
}
