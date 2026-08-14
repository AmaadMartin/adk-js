/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {Content} from '@google/genai';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {Event} from '../events/event.js';
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
  /** The artifact service the runner was built with, if it has one. */
  artifactService?: BaseArtifactService;
}

/**
 * Creates an A2A Agent Executor context from the given parameters.
 * @param session The session.
 * @param userContent The content of the user.
 * @param requestContext The request context.
 * @param artifactService The artifact service the runner was built with.
 * @returns The A2A Agent Executor context.
 */
export function createExecutorContext({
  session,
  userContent,
  requestContext,
  artifactService,
}: {
  session: Session;
  userContent: Content;
  requestContext: RequestContext;
  artifactService?: BaseArtifactService;
}): ExecutorContext {
  return {
    userId: session.userId,
    sessionId: session.id,
    appName: session.appName,
    readonlyState: session.state,
    events: session.events,
    userContent,
    requestContext,
    artifactService,
  };
}
