/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Content, createUserContent} from '@google/genai';
import {cloneDeep} from 'lodash-es';

import {
  CompactedEvent,
  isCompactedEvent,
} from '../../events/compacted_event.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {isSegmentPrefix} from '../../utils/branch_trie.js';

import {
  ADK_FRAMEWORK_FUNCTION_CALL_NAME,
  AF_FUNCTION_CALL_ID_PREFIX,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
} from '../functions.js';

/**
 * Removes the client-generated function call IDs from a given content object.
 *
 * When sending content back to the server, these IDs are
 * specific to the client-side and should not be included in requests to the
 * model.
 */
export function removeClientFunctionCallId(content: Content): void {
  for (const part of content?.parts ?? []) {
    if (part.functionCall?.id?.startsWith(AF_FUNCTION_CALL_ID_PREFIX)) {
      part.functionCall.id = undefined;
    }
    if (part.functionResponse?.id?.startsWith(AF_FUNCTION_CALL_ID_PREFIX)) {
      part.functionResponse.id = undefined;
    }
  }
}

/**
 * Get the contents for the LLM request.
 *
 * @param events: A list of all session events.
 * @param agentName: The name of the agent.
 * @param currentBranch: The current branch of the agent.
 * @param currentIsolationScope: The isolation scope of the current node, if any.
 *
 * @returns A list of processed contents.
 */
export function getContents(
  events: Event[],
  agentName: string,
  currentBranch?: string,
  currentIsolationScope?: string,
): Content[] {
  const includedEvents: Event[] = [];

  for (const event of events) {
    if (isCompactedEvent(event)) {
      includedEvents.push(convertCompactedEvent(event));
      continue;
    }

    if (
      !shouldIncludeEventInContext(event, currentBranch, currentIsolationScope)
    ) {
      continue;
    }

    includedEvents.push(event);
  }

  const callAuthorById = functionCallAuthorsById(includedEvents);
  const filteredEvents = includedEvents.map((event) =>
    isEventFromAnotherAgent(agentName, event) ||
    repliesToAnotherAgentCall(event, agentName, callAuthorById)
      ? convertForeignEvent(event)
      : event,
  );

  let resultEvents = rearrangeEventsForLatestFunctionResponse(filteredEvents);
  resultEvents =
    rearrangeEventsForAsyncFunctionResponsesInHistory(resultEvents);
  const contents = [];
  for (const event of resultEvents) {
    const content = cloneDeep(event.content!);
    removeClientFunctionCallId(content);
    contents.push(content);
  }
  return contents;
}

/**
 * Whether an event may appear in an LLM request at all: it carries content,
 * belongs to the current branch and isolation scope, and is not an internal
 * auth/confirmation event.
 *
 * Shared by {@link getContents} and {@link getCurrentTurnContents} so the scan
 * for where a turn starts cannot settle on an event the build then drops —
 * which yields empty contents. Mirrors Python's
 * `_should_include_event_in_context`, which its equivalent scan also applies.
 */
function shouldIncludeEventInContext(
  event: Event,
  currentBranch?: string,
  currentIsolationScope?: string,
): boolean {
  if (!event.content?.role || event.content.parts?.[0]?.text === '') {
    return false;
  }
  if (
    currentBranch &&
    event.branch &&
    !isSegmentPrefix(currentBranch, event.branch)
  ) {
    return false;
  }
  if (isOutsideIsolationScope(event, currentIsolationScope)) {
    return false;
  }
  return (
    !isAuthEvent(event) &&
    !isToolConfirmationEvent(event) &&
    !isRequestInputEvent(event) &&
    !isAdkFrameworkEvent(event)
  );
}

/**
 * Whether the event carries a function call or a function response named
 * `functionName`.
 */
function hasFunctionCallNamed(event: Event, functionName: string): boolean {
  for (const part of event.content?.parts ?? []) {
    if (
      part.functionCall?.name === functionName ||
      part.functionResponse?.name === functionName
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the event is a workflow human-input interrupt or its reply.
 *
 * Like the auth and tool-confirmation interrupts alongside it, this exchange is
 * between the framework and the client, not something the model asked for. An
 * agent that never issued the call must not be shown its reply: the reply would
 * arrive as a function response with no matching call in view, which the
 * rearrange step rejects outright.
 */
function isRequestInputEvent(event: Event): boolean {
  return hasFunctionCallNamed(event, REQUEST_INPUT_FUNCTION_CALL_NAME);
}

/**
 * Whether the event is one the framework emitted for its own bookkeeping.
 *
 * It records what the framework did, not what the conversation said, so the
 * model never sees it.
 */
function isAdkFrameworkEvent(event: Event): boolean {
  return hasFunctionCallNamed(event, ADK_FRAMEWORK_FUNCTION_CALL_NAME);
}

/**
 * Get contents for the current turn only (no conversation history).
 *
 * When include_contents='none', we want to include:
 * - The current user input
 * - Tool calls and responses from the current turn
 * But exclude conversation history from previous turns.
 *
 * In multi-agent scenarios, the "current turn" for an agent starts from an
 * actual user or from another agent.
 *
 * @param events: A list of all session events.
 * @param agentName: The name of the agent.
 * @param currentBranch: The current branch of the agent.
 *
 * @returns A list of contents for the current turn only, preserving context
 *     needed for proper tool execution while excluding conversation history.
 */
export function getCurrentTurnContents(
  events: Event[],
  agentName: string,
  currentBranch?: string,
  currentIsolationScope?: string,
): Content[] {
  // Find the latest event that starts the current turn and process from there.
  // A posted-back tool result is not a turn start, and the window must reach
  // back far enough to include the call it answers: the conversation can carry
  // on while a long-running tool is pending, so an ordinary user turn can sit
  // between the two, and anchoring there would leave the result orphaned.
  const unmatchedResponseIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    for (const functionCall of getFunctionCalls(event)) {
      if (functionCall.id) {
        unmatchedResponseIds.delete(functionCall.id);
      }
    }
    const isSubmittedResult = isSubmittedToolResult(event);
    if (isSubmittedResult) {
      for (const functionResponse of getFunctionResponses(event)) {
        if (functionResponse.id) {
          unmatchedResponseIds.add(functionResponse.id);
        }
      }
    }
    if (
      unmatchedResponseIds.size === 0 &&
      shouldIncludeEventInContext(
        event,
        currentBranch,
        currentIsolationScope,
      ) &&
      (event.author === 'user' || isEventFromAnotherAgent(agentName, event)) &&
      !isDirectTransfer(event) &&
      !isSubmittedResult
    ) {
      return getContents(
        events.slice(turnStart(events, i)),
        agentName,
        currentBranch,
        currentIsolationScope,
      );
    }
  }

  return [];
}

/**
 * Widens the turn window back over a function call the turn answers.
 *
 * The anchor scan above walks back past a result the caller posted itself. A
 * result the agent produced is different: it is authored by the agent, so the
 * scan can settle on a later event from another agent and leave the result
 * without its call. adk-python drops such a response as an orphan; adk-js
 * rejects it, so the window is widened to keep the pair together. A tool that
 * paused for confirmation is the case that reaches this: it is called in one
 * turn and answered in the next.
 */
function turnStart(events: Event[], anchor: number): number {
  const answered = new Set<string>();
  for (const event of events.slice(anchor)) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.id) {
        answered.add(part.functionResponse.id);
      }
    }
  }
  if (answered.size === 0) {
    return anchor;
  }
  let start = anchor;
  for (let i = anchor - 1; i >= 0; i--) {
    const answersACall = (events[i].content?.parts ?? []).some((p) =>
      p.functionCall?.id ? answered.has(p.functionCall.id) : false,
    );
    if (answersACall) {
      start = i;
    }
  }
  return start;
}

/**
 * Whether the event is a tool result the caller posted back.
 *
 * A long-running tool is finished by calling the runner again with the result
 * as the new message, which lands as a user-authored function response. It
 * answers a call the model made earlier, so it continues the turn rather than
 * starting one. Anchoring on it would cut the history above the matching
 * function call, and the response left with nothing to pair with is then
 * rejected as an orphan.
 */
function isSubmittedToolResult(event: Event): boolean {
  return event.author === 'user' && getFunctionResponses(event).length > 0;
}

/**
 * Whether the event hands control to another agent.
 *
 * When `includeContents` is `'none'` and a parent transfers to a sub-agent, the
 * trailing transfer events must not start the sub-agent's turn: the turn would
 * anchor on the transfer and drop the user input that caused it. The transfer
 * events still reach the model as relayed context.
 *
 * `actions` is declared required, but an event rehydrated from storage can
 * arrive without it, hence the optional chaining.
 */
function isDirectTransfer(event: Event): boolean {
  if (event.actions?.transferToAgent) {
    return true;
  }
  return (event.content?.parts ?? []).some(
    (part) => part.functionCall?.name === TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
  );
}

/**
 * Whether an event belongs to a different isolation scope than the one asking
 * for it, and so must be withheld.
 *
 * A tagged event is visible only within its own scope; an untagged event is
 * shared history and visible everywhere. So an isolated node sees the ambient
 * conversation plus its own turns, while its peers never see those turns.
 */
function isOutsideIsolationScope(
  event: Event,
  currentIsolationScope?: string,
): boolean {
  return (
    event.isolationScope !== undefined &&
    event.isolationScope !== currentIsolationScope
  );
}

/**
 * Whether the event is an auth event.
 *
 * An auth event is an event that contains a function call or response
 * related to requesting end-user credentials (EUC). These events are
 * skipped when constructing the content for the LLM request.
 */
function isAuthEvent(event: Event): boolean {
  return hasFunctionCallNamed(event, REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
}

/**
 * Whether the event is a tool confirmation event.
 *
 * A tool confirmation event is an event that contains a function call or
 * response related to requesting confirmation for a tool call. These events
 * are skipped when constructing the content for the LLM request.
 */
function isToolConfirmationEvent(event: Event): boolean {
  return hasFunctionCallNamed(event, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
}

/**
 * Whether the event is from another agent.
 */
function isEventFromAnotherAgent(agentName: string, event: Event): boolean {
  return !!agentName && event.author !== agentName && event.author !== 'user';
}

/**
 * Maps every function call id in `events` to the author of the event that
 * issued the call. An absent author reads the same way as an id the map does
 * not hold: a call nobody else made.
 */
function functionCallAuthorsById(
  events: Event[],
): Map<string, string | undefined> {
  const authorById = new Map<string, string | undefined>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall?.id) {
        authorById.set(part.functionCall.id, event.author);
      }
    }
  }
  return authorById;
}

/**
 * Whether the event answers a function call another agent made.
 *
 * A delegation reply is commonly written under `user` or under the current
 * agent, so the author alone does not identify it. The call it answers does: an
 * agent that never made the call must be shown the reply as context, because a
 * response with no matching call in view is what the rearrange step rejects.
 *
 * A call the current agent made, and a call `user` made, both leave the event
 * alone — as does a response whose id matches no call in the window.
 */
function repliesToAnotherAgentCall(
  event: Event,
  agentName: string,
  callAuthorById: Map<string, string | undefined>,
): boolean {
  for (const part of event.content?.parts ?? []) {
    const responseId = part.functionResponse?.id;
    const callAuthor = responseId ? callAuthorById.get(responseId) : undefined;
    if (callAuthor && callAuthor !== agentName && callAuthor !== 'user') {
      return true;
    }
  }
  return false;
}

/**
 * Formats an event authored by another agent to a user-content event.
 *
 * This is to provide another agent's output as context to the current agent,
 * so that current agent can continue to respond, such as summarizing previous
 * agent's reply, etc.
 *
 * @param event The event to convert.
 *
 * @returns The converted event.
 */
function convertForeignEvent(event: Event): Event {
  if (!event.content?.parts?.length) {
    return event;
  }

  const content: Content = {
    role: 'user',
    parts: [
      {
        text: 'For context:',
      },
    ],
  };

  for (const part of event.content.parts) {
    // Exclude thoughts from the context.
    // TODO - b/425992518: filtring should be configurable.
    if (part.text && !part.thought) {
      content.parts?.push({
        text: `[${event.author}] said: ${part.text}`,
      });
    } else if (part.functionCall) {
      content.parts?.push({
        text: `[${event.author}] called tool \`${part.functionCall.name}\` with parameters: ${safeStringify(
          part.functionCall.args,
        )}`,
      });
    } else if (part.functionResponse) {
      content.parts?.push({
        text: `[${event.author}] tool \`${part.functionResponse.name}\` returned result: ${safeStringify(
          part.functionResponse.response,
        )}`,
      });
    } else {
      content.parts?.push(cloneDeep(part));
    }
  }

  return createEvent({
    invocationId: event.invocationId,
    author: 'user',
    content,
    branch: event.branch,
    timestamp: event.timestamp,
  });
}

/**
 * Merges a list of function_response events into one event.
 *
 * The key goal is to ensure:
 *  1. function_call and function_response are always of the same number.
 *  2. The function_call and function_response are consecutively in the content.
 *
 * @param events: A list of function_response events.
 *
 * NOTE:
 * function_response_events must fulfill these requirements:
 * 1. The list is in increasing order of timestamp;
 * 2. the first event is the initial function_response event;
 * 3. all later events should contain at least one function_response part that
 * related to the function_call event. Caveat: This implementation doesn't
 * support when a parallel function_call event contains async function_call of
 * the same name.
 *
 * @returns
 *    A merged event, that is
 *      1. All later function_response will replace function_response part in
 *          the initial function_response event.
 *      2. All non-function_response parts will be appended to the part list of
 *          the initial function_response event.
 */
export function mergeFunctionResponseEvents(events: Event[]): Event {
  if (events.length === 0) {
    throw new Error('Cannot merge an empty list of events.');
  }

  const mergedEvent = createEvent({
    ...events[0],
    content: events[0].content ? cloneDeep(events[0].content) : undefined,
  });
  const partsInMergedEvent = mergedEvent.content?.parts;
  if (!partsInMergedEvent || partsInMergedEvent.length === 0) {
    throw new Error('There should be at least one function_response part.');
  }

  const partIndicesInMergedEvent: Record<string, number> = {};
  for (let i = 0; i < partsInMergedEvent.length; i++) {
    const part = partsInMergedEvent[i];
    if (part.functionResponse && part.functionResponse.id) {
      partIndicesInMergedEvent[part.functionResponse.id] = i;
    }
  }

  for (const event of events.slice(1)) {
    if (!event.content || !event.content.parts) {
      throw new Error('There should be at least one function_response part.');
    }
    for (const part of event.content.parts) {
      const clonedPart = cloneDeep(part);
      if (clonedPart.functionResponse && clonedPart.functionResponse.id) {
        const functionCallId = clonedPart.functionResponse.id;
        if (functionCallId in partIndicesInMergedEvent) {
          partsInMergedEvent[partIndicesInMergedEvent[functionCallId]] =
            clonedPart;
        } else {
          partsInMergedEvent.push(clonedPart);
          partIndicesInMergedEvent[functionCallId] =
            partsInMergedEvent.length - 1;
        }
      } else {
        partsInMergedEvent.push(clonedPart);
      }
    }
  }

  return mergedEvent;
}

/**
 * Rearrange the async functionResponse events in the history.
 */
function rearrangeEventsForLatestFunctionResponse(events: Event[]): Event[] {
  if (events.length === 0) {
    return events;
  }

  const latestEvent = events[events.length - 1];
  const functionResponses = getFunctionResponses(latestEvent);

  // No need to process, since the latest event is not functionResponse.
  if (!functionResponses?.length) {
    return events;
  }

  const functionResponsesIds = new Set<string>(
    functionResponses
      .filter((response): response is {id: string} => !!response.id)
      .map((response) => response.id),
  );

  // No need to rearrange if the second latest event already contains the
  // corresponding function calls for the latest function responses.
  const secondLatestEvent = events.at(-2);
  if (secondLatestEvent) {
    const functionCallsFromSecondLatest = getFunctionCalls(secondLatestEvent);
    if (functionCallsFromSecondLatest) {
      for (const functionCall of functionCallsFromSecondLatest) {
        if (functionCall.id && functionResponsesIds.has(functionCall.id)) {
          return events;
        }
      }
    }
  }

  // Look for corresponding function call event reversely.
  let match: {eventIdx: number; responseIds: Set<string>} | undefined;

  for (let idx = events.length - 2; idx >= 0; idx--) {
    const event = events[idx];
    const functionCalls = getFunctionCalls(event);
    if (!functionCalls?.length) {
      continue;
    }

    let matchedInEvent = false;
    for (const functionCall of functionCalls) {
      if (functionCall.id && functionResponsesIds.has(functionCall.id)) {
        const functionCallIds = new Set<string>(
          functionCalls.map((fc) => fc.id).filter((id): id is string => !!id),
        );

        // Check if functionResponsesIds is a subset of functionCallIds
        const isSubset = Array.from(functionResponsesIds).every((id) =>
          functionCallIds.has(id),
        );

        if (!isSubset) {
          throw new Error(
            'Last response event should only contain the responses for the' +
              ' function calls in the same function call event. Function' +
              ` call ids found : ${Array.from(functionCallIds).join(
                ', ',
              )}, function response` +
              ` ids provided: ${Array.from(functionResponsesIds).join(', ')}`,
          );
        }
        match = {eventIdx: idx, responseIds: functionCallIds};
        matchedInEvent = true;
        break;
      }
    }
    if (matchedInEvent) {
      break;
    }
  }

  if (!match) {
    throw new Error(
      `No function call event found for function responses ids: ${Array.from(
        functionResponsesIds,
      ).join(', ')}`,
    );
  }

  // Collect all function response events between the function call event
  // and the last function response event
  const functionResponseEvents: Event[] = [];
  const activeResponses = match.responseIds;
  for (let idx = match.eventIdx + 1; idx < events.length - 1; idx++) {
    const event = events[idx];
    const responses = getFunctionResponses(event);
    if (
      responses &&
      responses.some(
        (response) => response.id && activeResponses.has(response.id),
      )
    ) {
      functionResponseEvents.push(event);
    }
  }
  functionResponseEvents.push(events[events.length - 1]);

  const resultEvents = events.slice(0, match.eventIdx + 1);
  resultEvents.push(mergeFunctionResponseEvents(functionResponseEvents));

  return resultEvents;
}

/**
 * Rearrange the events for the latest function_response.
 *
 * If the latest function_response is for an async function_call, all events
 * between the initial function_call and the latest function_response will be
 * removed.
 *
 * @param event: A list of events.
 *
 * @returns A list of events with the latest function_response rearranged.
 */
function rearrangeEventsForAsyncFunctionResponsesInHistory(
  events: Event[],
): Event[] {
  const functionCallIdToResponseEventIndex: Map<string, number> = new Map();

  // First pass: Map function_call_id to the index of their
  // corresponding response events.
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const functionResponses = getFunctionResponses(event);
    if (functionResponses?.length) {
      for (const functionResponse of functionResponses) {
        if (!functionResponse.id) {
          continue;
        }

        functionCallIdToResponseEventIndex.set(functionResponse.id, i);
      }
    }
  }

  const resultEvents: Event[] = [];

  // Second pass: Build the new ordered list of events.
  for (const event of events) {
    // If the event contains function responses, it will be handled when
    // its corresponding function_call is encountered, so skip it for now.
    if (getFunctionResponses(event).length > 0) {
      continue;
    }

    const functionCalls = getFunctionCalls(event);
    if (functionCalls?.length) {
      const functionResponseEventsIndices: Set<number> = new Set();
      for (const functionCall of functionCalls) {
        const functionCallId = functionCall.id;
        if (
          functionCallId &&
          functionCallIdToResponseEventIndex.has(functionCallId)
        ) {
          functionResponseEventsIndices.add(
            functionCallIdToResponseEventIndex.get(functionCallId)!,
          );
        }
      }

      resultEvents.push(event);

      if (functionResponseEventsIndices.size === 0) {
        continue;
      }

      if (functionResponseEventsIndices.size === 1) {
        const [responseIndex] = Array.from(functionResponseEventsIndices);
        resultEvents.push(events[responseIndex]);
      } else {
        const indicesArray = Array.from(functionResponseEventsIndices).sort(
          (a, b) => a - b,
        );
        const eventsToMerge = indicesArray.map((index) => events[index]);
        resultEvents.push(mergeFunctionResponseEvents(eventsToMerge));
      }
    } else {
      resultEvents.push(event);
    }
  }

  return resultEvents;
}

/**
 * Safely stringifies an object, handling circular references.
 */
function safeStringify(obj: unknown): string {
  if (typeof obj === 'string') {
    return obj;
  }
  try {
    return JSON.stringify(obj);
  } catch (_e: unknown) {
    return String(obj);
  }
}

/**
 * Formats a CompactedEvent to a user-content event for the LLM context.
 *
 * @param event The CompactedEvent to convert.
 *
 * @returns The converted event.
 */
function convertCompactedEvent(event: CompactedEvent): Event {
  const content = createUserContent(
    `[Previous Context Summary]:\n${event.compactedContent}`,
  );

  return createEvent({
    invocationId: event.invocationId,
    author: 'user',
    content,
    branch: event.branch,
    timestamp: event.timestamp,
  });
}
