/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Event, getFunctionCalls} from '../events/event.js';
import {Session} from './session.js';

/**
 * The invocation that the function responses in `newMessage` answer.
 *
 * Every response must match a function call already in the session, and every
 * match must land on the same invocation: a message answering parallel tool
 * calls must not attribute the rest to whichever invocation came first.
 *
 * @returns The invocation id, or `undefined` when the message carries no
 *     function response id.
 * @throws {Error} When a response matches no call, or the responses span more
 *     than one invocation.
 */
export function resolveInvocationIdFromFr(
  session: Session,
  newMessage: Content,
): string | undefined {
  const unmatchedIds = new Set<string>();
  for (const part of newMessage.parts ?? []) {
    const id = part.functionResponse?.id;
    if (id) {
      unmatchedIds.add(id);
    }
  }
  if (!unmatchedIds.size) {
    return undefined;
  }

  const invocationIds = new Set<string>();
  for (let i = session.events.length - 1; i >= 0 && unmatchedIds.size; i--) {
    const event = session.events[i];
    for (const call of getFunctionCalls(event)) {
      if (call.id && unmatchedIds.delete(call.id)) {
        invocationIds.add(event.invocationId);
      }
    }
  }

  if (unmatchedIds.size) {
    throw new Error(
      `Function call not found for function response ids: ${[
        ...unmatchedIds,
      ]}. Ensure each function response ID matches an existing function call ` +
        'in the session history.',
    );
  }
  if (invocationIds.size > 1) {
    throw new Error(
      `Function responses resolve to multiple invocations: ${[
        ...invocationIds,
      ]}. All function responses in a single message must belong to the same ` +
        'invocation.',
    );
  }
  return [...invocationIds][0];
}

/**
 * The user message that started an invocation.
 *
 * A part carrying text anywhere in the message qualifies, not just the first
 * one: a multimodal turn commonly leads with an image and puts the question
 * after it. A turn made only of function responses is an answer to the
 * invocation, not its opening message, so it is skipped.
 */
export function findUserMessageForInvocation(
  events: Event[],
  invocationId: string,
): Content | undefined {
  for (const event of events) {
    if (
      event.invocationId === invocationId &&
      event.author === 'user' &&
      event.content?.parts?.length &&
      !event.content.parts.some((part) => part.functionResponse)
    ) {
      return event.content;
    }
  }
  return undefined;
}
