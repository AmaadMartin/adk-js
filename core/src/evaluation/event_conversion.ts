/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a recorded event log into the eval data model.
 *
 * Ports `EvaluationGenerator.convert_events_to_eval_invocations` from
 * `google/adk-python` (`src/google/adk/evaluation/evaluation_generator.py`).
 */

import {Content, Part} from '@google/genai';

import {Event, getFunctionCalls, isFinalResponse} from '../events/event.js';
import {Invocation, InvocationEvent} from './eval_case.js';

const USER_AUTHOR = 'user';
const DEFAULT_AUTHOR = 'agent';

function groupEventsByInvocationId(events: Event[]): Map<string, Event[]> {
  const grouped = new Map<string, Event[]>();
  for (const event of events) {
    const group = grouped.get(event.invocationId);
    if (group) {
      group.push(event);
    } else {
      grouped.set(event.invocationId, [event]);
    }
  }
  return grouped;
}

function isUserEvent(event: Event): boolean {
  return (event.author || DEFAULT_AUTHOR).toLowerCase() === USER_AUTHOR;
}

function hasTextPart(parts: Part[] | undefined): boolean {
  return (parts ?? []).some((part) => part.text);
}

/**
 * Reports whether the event is worth showing to an evaluator: it either grounds
 * the answer, or its content carries a tool call, a tool result, text or
 * inline data.
 */
function carriesSignal(event: Event): boolean {
  if (event.groundingMetadata) {
    return true;
  }
  return (event.content?.parts ?? []).some(
    (part) =>
      part.functionCall ||
      part.functionResponse ||
      part.text ||
      part.inlineData,
  );
}

/**
 * Reports whether the candidate content replaces the current final response.
 *
 * A live turn emits the answer twice, as audio and as a text transcript, so a
 * text candidate always wins over a response that has no text part.
 */
function beatsCurrentFinalResponse(
  current: Content | undefined,
  candidate: Content,
): boolean {
  return !hasTextPart(current?.parts) || hasTextPart(candidate.parts);
}

/**
 * Projects the events of one invocation for an evaluator.
 *
 * The event chosen as the final response is dropped, because
 * {@link Invocation.finalResponse} already holds it. It is kept when it also
 * carries a tool call or grounding metadata, which the evaluator has no other
 * way to read, and then its content is repeated only for the tool call.
 */
function toInvocationEvents(
  candidates: Event[],
  finalEvent: Event | undefined,
): InvocationEvent[] {
  const invocationEvents: InvocationEvent[] = [];
  for (const event of candidates) {
    const isChosenFinal =
      event === finalEvent && getFunctionCalls(event).length === 0;
    if (isChosenFinal && !event.groundingMetadata) {
      continue;
    }
    invocationEvents.push({
      author: event.author || DEFAULT_AUTHOR,
      content: isChosenFinal ? undefined : event.content,
      groundingMetadata: event.groundingMetadata,
    });
  }
  return invocationEvents;
}

function toInvocation(invocationId: string, events: Event[]): Invocation {
  let userContent: Content = {parts: []};
  let creationTimestamp = 0;
  let finalResponse: Content | undefined;
  let finalEvent: Event | undefined;
  const candidates: Event[] = [];

  for (const event of events) {
    if (isUserEvent(event)) {
      if (event.content) {
        userContent = event.content;
        creationTimestamp = event.timestamp;
      }
      continue;
    }

    if (
      event.content?.parts?.length &&
      isFinalResponse(event) &&
      beatsCurrentFinalResponse(finalResponse, event.content)
    ) {
      finalResponse = event.content;
      finalEvent = event;
    }

    if (carriesSignal(event)) {
      candidates.push(event);
    }
  }

  return {
    invocationId,
    userContent,
    finalResponse,
    intermediateData: {
      invocationEvents: toInvocationEvents(candidates, finalEvent),
    },
    creationTimestamp,
  };
}

/**
 * Converts a list of events into eval invocations, one per invocation id.
 *
 * The events are grouped by {@link Event.invocationId} and each group becomes
 * one {@link Invocation} holding the user's request, the agent's final
 * response, and the intermediate events that led to it. The output keeps the
 * order in which each invocation id first appears.
 *
 * The events are not copied: an {@link InvocationEvent} shares the `Content`
 * object of the event it came from.
 *
 * @param events The events to convert.
 * @returns One invocation per distinct invocation id.
 */
export function convertEventsToEvalInvocations(events: Event[]): Invocation[] {
  return [...groupEventsByInvocationId(events)].map(([invocationId, group]) =>
    toInvocation(invocationId, group),
  );
}
