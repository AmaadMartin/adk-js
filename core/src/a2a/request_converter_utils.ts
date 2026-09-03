/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {Content as GenAIContent, Part as GenAIPart} from '@google/genai';
import {
  A2APartToGenAIPartConverter,
  toGenAIPart,
} from './part_converter_utils.js';
import {getA2aRequestMetadata} from './request_metadata.js';

/**
 * The `customMetadata` key that carries the incoming A2A request metadata into
 * the run.
 *
 * This is a request-level key. It is unrelated to the `a2a:` prefix that
 * `metadata_converter_utils.ts` puts on A2A event metadata keys.
 */
export const A2A_METADATA_KEY = 'a2a_metadata';

/**
 * The arguments for one `Runner.runAsync` call.
 */
export interface AgentRunRequest {
  userId?: string;
  sessionId?: string;
  newMessage?: GenAIContent;
  customMetadata?: Record<string, unknown>;
}

/**
 * Resolves the ADK user id for an A2A request.
 *
 * @param request - The incoming A2A request context.
 * @returns The authenticated user name when the A2A server authenticates the
 *   caller, and a name derived from the context id otherwise.
 */
export function getUserId(request: RequestContext): string {
  const userName = request.context?.user?.userName;
  if (userName) {
    return userName;
  }

  return `A2A_USER_${request.contextId}`;
}

/**
 * Converts an A2A request context into the arguments for `Runner.runAsync`.
 *
 * @param request - The incoming A2A request context.
 * @param partConverter - Converts one part of the user message. Defaults to
 *   `toGenAIPart`.
 * @returns The arguments for a single run.
 * @throws {Error} If the request carries no message.
 */
export function convertA2aRequestToAgentRunRequest(
  request: RequestContext,
  partConverter: A2APartToGenAIPartConverter = toGenAIPart,
): AgentRunRequest {
  if (!request.userMessage) {
    throw new Error('Request message cannot be None');
  }

  const customMetadata: Record<string, unknown> = {};
  const requestMetadata = getA2aRequestMetadata(request);
  if (requestMetadata && Object.keys(requestMetadata).length > 0) {
    customMetadata[A2A_METADATA_KEY] = requestMetadata;
  }

  const parts: GenAIPart[] = [];
  for (const a2aPart of request.userMessage.parts) {
    const converted = partConverter(a2aPart);
    if (Array.isArray(converted)) {
      parts.push(...converted);
    } else if (converted) {
      parts.push(converted);
    }
  }

  return {
    userId: getUserId(request),
    sessionId: request.contextId,
    // An object literal rather than `createUserContent`: that helper throws on
    // an empty array, and a message whose parts all convert to nothing must
    // still produce `parts: []`.
    newMessage: {role: 'user', parts},
    customMetadata,
  };
}
