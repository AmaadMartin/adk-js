/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {Content as GenAIContent} from '@google/genai';
import {
  A2APartToGenAIPartConverter,
  toGenAIContent,
  toGenAIPart,
} from './part_converter_utils.js';

/**
 * The arguments the A2A executor passes to the ADK runner.
 */
export interface AgentRunRequest {
  userId: string;
  sessionId: string;
  newMessage: GenAIContent;
}

/**
 * Converts an incoming A2A request into the ADK runner arguments.
 *
 * The default implementation is `toAgentRunRequest`.
 */
export type A2ARequestToAgentRunRequestConverter = (
  requestContext: RequestContext,
  a2aPartConverter: A2APartToGenAIPartConverter,
) => AgentRunRequest;

/**
 * Derives the ADK runner arguments from an A2A request context.
 *
 * The user is scoped to the A2A context, and the ADK session id is the A2A
 * context id, so every task on one context continues the same conversation.
 *
 * @param requestContext - The incoming A2A request context.
 * @param a2aPartConverter - Converts a single part of the user message.
 *   Defaults to `toGenAIPart`.
 * @returns The arguments for a single `runner.runAsync` call.
 */
export function toAgentRunRequest(
  requestContext: RequestContext,
  a2aPartConverter: A2APartToGenAIPartConverter = toGenAIPart,
): AgentRunRequest {
  return {
    userId: `A2A_USER_${requestContext.contextId}`,
    sessionId: requestContext.contextId,
    newMessage: toGenAIContent(requestContext.userMessage, a2aPartConverter),
  };
}
