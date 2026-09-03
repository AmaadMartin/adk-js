/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {Content as GenAIContent} from '@google/genai';
import {RunConfig} from '../agents/run_config.js';
import {
  A2APartToGenAIPartConverter,
  toGenAIContent,
  toGenAIPart,
} from './part_converter_utils.js';

/**
 * The arguments the ADK runner needs to run one A2A request.
 */
export interface AgentRunRequest {
  userId: string;
  sessionId: string;
  newMessage: GenAIContent;
  /**
   * Run configuration the converter derived from the request. The executor
   * merges it over its own configured run config.
   */
  runConfig?: RunConfig;
}

/**
 * Derives the ADK runner arguments from an inbound A2A request.
 *
 * Supply one on the executor config to control how a request maps onto a user,
 * a session and a message, for example to attribute runs to a principal your
 * own middleware resolved.
 */
export type A2ARequestToAgentRunRequestConverter = (
  request: RequestContext,
  partConverter: A2APartToGenAIPartConverter,
) => AgentRunRequest;

/**
 * The user a request runs as.
 *
 * An authenticated A2A server puts the principal on the call context, and that
 * name is used as-is. Otherwise the request is anonymous and runs under a name
 * derived from the context id, which keeps one conversation on one user.
 */
export function getUserId(request: RequestContext): string {
  const userName = request.context?.user?.userName;

  return userName ? userName : `A2A_USER_${request.contextId}`;
}

/**
 * Converts an A2A request into the arguments for `Runner.runAsync`.
 *
 * @throws {Error} When the request carries no user message.
 */
export function convertA2aRequestToAgentRunRequest(
  request: RequestContext,
  partConverter: A2APartToGenAIPartConverter = toGenAIPart,
): AgentRunRequest {
  if (!request.userMessage) {
    throw new Error('message not provided');
  }

  return {
    userId: getUserId(request),
    sessionId: request.contextId,
    newMessage: toGenAIContent(request.userMessage, partConverter),
  };
}
