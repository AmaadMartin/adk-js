/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '@google/adk';
import {Content} from '@google/genai';
import {UserMessage} from './test_types.js';

/** Builds the content to send for a user message of a test spec. */
export function userMessageToContent(msg: UserMessage): Content {
  if (msg.content) {
    const content = msg.content;
    content.role = 'user';
    return content;
  }
  if (msg.text) {
    return {role: 'user', parts: [{text: msg.text}]};
  }

  throw new Error('Either Content text or content field is required');
}

/**
 * Gives the message's function response the id of the function call it
 * answers.
 *
 * A spec names the function it responds to but cannot know the id, which the
 * model only produces at run time. Long-running tools are the case that needs
 * it.
 *
 * @throws if no function call of that name is pending.
 */
export function resolveFunctionResponseId(
  content: Content,
  pendingFunctionCallIds: ReadonlyMap<string, string>,
): void {
  const functionResponse = content.parts?.[0]?.functionResponse;
  if (!functionResponse?.name) {
    return;
  }

  const id = pendingFunctionCallIds.get(functionResponse.name);
  if (!id) {
    throw new Error(
      `Function response for ${functionResponse.name} does not match any pending function call.`,
    );
  }
  functionResponse.id = id;
}

/** Records the id of every function call the event carries, by name. */
export function collectFunctionCallIds(
  event: Event,
  pendingFunctionCallIds: Map<string, string>,
): void {
  for (const part of event.content?.parts ?? []) {
    const functionCall = part.functionCall;
    if (functionCall?.name && functionCall.id) {
      pendingFunctionCallIds.set(functionCall.name, functionCall.id);
    }
  }
}
