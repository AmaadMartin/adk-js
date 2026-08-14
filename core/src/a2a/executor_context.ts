/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RequestContext} from '@a2a-js/sdk/server';
import type {Content} from '@google/genai';
import type {Event} from '../events/event.js';
import type {Session} from '../sessions/session.js';
import type {ContextMutation, IntentBinding} from './intent_binding.js';

/**
 * The A2A Agent Executor context.
 */
export interface ExecutorContext {
  userId: string;
  sessionId: string;
  appName: string;
  readonlyState: Record<string, unknown>;
  events: Event[];
  userContent: Content;
  requestContext: RequestContext;
  /** The action frozen when the task paused, when resuming a paused task. */
  pausedIntent?: IntentBinding;
  /** Whether other messages arrived while the task was paused. */
  contextMutation?: ContextMutation;
}

/**
 * Creates an A2A Agent Executor context from the given parameters.
 * @param session The session.
 * @param userContent The content of the user.
 * @param requestContext The request context.
 * @returns The A2A Agent Executor context.
 */
export function createExecutorContext({
  session,
  userContent,
  requestContext,
}: {
  session: Session;
  userContent: Content;
  requestContext: RequestContext;
}): ExecutorContext {
  return {
    userId: session.userId,
    sessionId: session.id,
    appName: session.appName,
    readonlyState: session.state,
    events: session.events,
    userContent,
    requestContext,
  };
}
