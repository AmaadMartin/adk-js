/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {Content} from '@google/genai';
import {Event} from '../events/event.js';
import {Runner} from '../runner/runner.js';
import {Session} from '../sessions/session.js';

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
  /** The runner executing this request, and the services it was built with. */
  runner: Runner;
}

/**
 * Creates an A2A Agent Executor context from the given parameters.
 * @param session The session.
 * @param userContent The content of the user.
 * @param requestContext The request context.
 * @param runner The runner executing this request.
 * @returns The A2A Agent Executor context.
 */
export function createExecutorContext({
  session,
  userContent,
  requestContext,
  runner,
}: {
  session: Session;
  userContent: Content;
  requestContext: RequestContext;
  runner: Runner;
}): ExecutorContext {
  return {
    userId: session.userId,
    sessionId: session.id,
    appName: session.appName,
    readonlyState: session.state,
    events: session.events,
    userContent,
    requestContext,
    runner,
  };
}
