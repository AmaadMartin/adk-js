/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionResponse} from '@google/genai';

import {Event, getFunctionCalls} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {Session} from './session.js';

/**
 * Returns the function responses carried by a message.
 *
 * Ported from `google/adk-python`
 * `runners.py::_get_function_responses_from_content`.
 */
export function getFunctionResponsesFromContent(
  content: Content | undefined,
): FunctionResponse[] {
  const responses: FunctionResponse[] = [];
  for (const part of content?.parts ?? []) {
    if (part.functionResponse) {
      responses.push(part.functionResponse);
    }
  }
  return responses;
}

/**
 * Maps the function responses in a message to the tool results they carry,
 * keyed by the id of the call each one answers.
 *
 * Returns `undefined` when the message carries none, which is what tells the
 * runner the message starts a turn rather than resuming one. Ported from
 * `google/adk-python` `runners.py::_extract_resume_inputs`.
 */
export function extractResumeInputs(
  message: Content | undefined,
): Record<string, unknown> | undefined {
  const inputs: Record<string, unknown> = {};
  for (const response of getFunctionResponsesFromContent(message)) {
    if (response.id) {
      inputs[response.id] = response.response;
    }
  }
  return Object.keys(inputs).length > 0 ? inputs : undefined;
}

/**
 * Rejects a message that mixes function responses with text.
 *
 * The two mean opposite things: a function response continues the invocation
 * that issued the call, while text starts a new one. A message asking for both
 * has no single correct reading, so it is refused rather than guessed at.
 * Ported from `google/adk-python` `runners.py::_validate_new_message`.
 *
 * @throws {Error} If the message carries both kinds of part.
 */
export function validateNewMessage(
  message: Content | undefined,
  resumeInputs: Record<string, unknown> | undefined,
): void {
  if (!resumeInputs) {
    return;
  }
  if ((message?.parts ?? []).some((part) => part.text)) {
    throw new Error(
      'Message cannot contain both function responses and text. Function ' +
        'responses resume an existing invocation while text starts a new one.',
    );
  }
}

/**
 * Resolves the invocation a message's function responses belong to, by matching
 * each response id against the function calls recorded in the session.
 *
 * Returns `undefined` when the message carries no function responses. Ported
 * from `google/adk-python` `runners.py::_resolve_invocation_id_from_fr`.
 *
 * @throws {Error} If a response answers no recorded call, or if the responses
 *   span more than one invocation.
 */
export function resolveInvocationIdFromFunctionResponses(
  session: Session,
  newMessage: Content,
): string | undefined {
  const unmatched = new Set<string>();
  for (const response of getFunctionResponsesFromContent(newMessage)) {
    if (response.id) {
      unmatched.add(response.id);
    }
  }
  if (unmatched.size === 0) {
    return undefined;
  }

  const invocationIds = new Set<string>();
  for (let i = session.events.length - 1; i >= 0 && unmatched.size > 0; i--) {
    const event = session.events[i];
    for (const call of getFunctionCalls(event)) {
      if (call.id && unmatched.delete(call.id)) {
        invocationIds.add(event.invocationId);
      }
    }
  }

  if (unmatched.size > 0) {
    throw new Error(
      `Function call not found for function response ids: ` +
        `${[...unmatched].join(', ')}. Ensure each function response ID ` +
        'matches an existing function call in the session history.',
    );
  }
  if (invocationIds.size > 1) {
    throw new Error(
      `Function responses resolve to multiple invocations: ` +
        `${[...invocationIds].join(', ')}. All function responses in a ` +
        'single message must belong to the same invocation.',
    );
  }
  return [...invocationIds][0];
}

/**
 * Resolves which invocation a run should continue.
 *
 * A caller-supplied `invocationId` is reconciled against the message's function
 * responses rather than trusted. Resuming under an id that does not own the
 * call means the call is not found and the tool result is dropped, so the
 * responses win and the mismatch is logged. Ported from `google/adk-python`
 * `runners.py::_resolve_invocation_id`.
 *
 * @throws {Error} If a function response carries no id.
 */
export function resolveInvocationId(
  session: Session,
  newMessage: Content | undefined,
  invocationId: string | undefined,
): string | undefined {
  if (!newMessage) {
    return invocationId;
  }
  const responses = getFunctionResponsesFromContent(newMessage);
  if (responses.length === 0) {
    return invocationId;
  }
  if (!responses[0].id) {
    throw new Error(
      'Function response id is required to resume an invocation.',
    );
  }

  const resolved = resolveInvocationIdFromFunctionResponses(
    session,
    newMessage,
  );
  if (invocationId && invocationId !== resolved) {
    logger.warn(
      `Provided invocationId ${invocationId} is ignored because newMessage ` +
        `has a function response with invocationId ${resolved}.`,
    );
  }
  return resolved;
}

/**
 * Finds the user message that started an invocation, so a resume can run the
 * agent against the turn it was already working on.
 *
 * Any user event with parts qualifies, whatever those parts hold: a multimodal
 * turn commonly leads with an image and puts the question after it, and an
 * image-only turn is a turn too. An event made only of function responses is
 * skipped, because it answers a call rather than opening the turn. Ported from
 * `google/adk-python` `runners.py::_find_user_message_for_invocation`.
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
