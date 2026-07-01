/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, Session, getFunctionCalls, isFinalResponse} from '@google/adk';
import {Content} from '@google/genai';
import {Invocation} from './evaluation_types.js';

const DEFAULT_AUTHOR = 'agent';
const USER_AUTHOR = 'user';

function collectEventsByInvocationId(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const event of events) {
    const invId = event.invocationId;
    if (!invId) continue;
    if (!map.has(invId)) {
      map.set(invId, []);
    }
    map.get(invId)!.push(event);
  }
  return map;
}

export function convertSessionToEvalInvocations(
  session: Session,
): Invocation[] {
  const events = session.events || [];
  const eventsByInvocationId = collectEventsByInvocationId(events);
  const invocations: Invocation[] = [];

  for (const [invocationId, invEvents] of eventsByInvocationId.entries()) {
    let finalResponse: Content | undefined = undefined;
    let finalEvent: Event | undefined = undefined;
    let userContent: Content = {parts: []};

    let invocationTimestamp = 0;
    const eventsToAdd: Event[] = [];

    for (const event of invEvents) {
      const author = (event.author || DEFAULT_AUTHOR).toLowerCase();

      if (author === USER_AUTHOR) {
        if (event.content) {
          userContent = event.content;
          invocationTimestamp = event.timestamp;
        }
        continue;
      }

      if (
        event.content &&
        event.content.parts &&
        event.content.parts.length > 0
      ) {
        if (isFinalResponse(event)) {
          finalResponse = event.content;
          finalEvent = event;
        }

        for (const part of event.content.parts) {
          if (
            part.functionCall ||
            part.functionResponse ||
            part.text ||
            part.inlineData
          ) {
            eventsToAdd.push(event);
            break;
          }
        }
      }
    }

    const invocationEvents = eventsToAdd
      .filter((e) => {
        return (
          finalEvent === undefined ||
          e !== finalEvent ||
          getFunctionCalls(e).length > 0
        );
      })
      .map((e) => ({
        author: e.author || DEFAULT_AUTHOR,
        content: e.content,
      }));

    invocations.push({
      invocationId,
      userContent,
      finalResponse,
      intermediateData: {
        invocation_events: invocationEvents,
      },
      creationTimestamp: invocationTimestamp / 1000,
    });
  }

  return invocations;
}
