/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {createSession, InMemoryArtifactService, Session} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createExecutorContext} from '../../src/a2a/executor_context.js';

describe('createExecutorContext', () => {
  const mockUserContent: Content = {role: 'user', parts: [{text: 'hello'}]};
  const mockRequestContext = {
    contextId: 'req-ctx-123',
  } as RequestContext;

  it('creates context with session', () => {
    const mockSession = {
      id: 'session-123',
      userId: 'user-1',
      appName: 'agent-1',
      state: {key: 'value'},
      events: [{kind: 'user_message', text: 'hi'}],
    } as unknown as Session;

    const context = createExecutorContext({
      session: mockSession,
      userContent: mockUserContent,
      requestContext: mockRequestContext,
    });

    expect(context).toEqual({
      userId: 'user-1',
      sessionId: 'session-123',
      appName: 'agent-1',
      readonlyState: {key: 'value'},
      events: mockSession.events,
      userContent: mockUserContent,
      requestContext: mockRequestContext,
    });
  });

  it('carries the artifact service it was given', () => {
    const session = createSession({
      id: 'session-123',
      userId: 'user-1',
      appName: 'agent-1',
    });
    const artifactService = new InMemoryArtifactService();

    const context = createExecutorContext({
      session,
      userContent: mockUserContent,
      requestContext: mockRequestContext,
      artifactService,
    });

    expect(context.artifactService).toBe(artifactService);
  });
});
