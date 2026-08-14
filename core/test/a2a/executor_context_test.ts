/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RequestContext} from '@a2a-js/sdk/server';
import {createEvent, createSession} from '@google/adk';
import type {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createExecutorContext} from '../../src/a2a/executor_context.js';

describe('createExecutorContext', () => {
  const mockUserContent: Content = {role: 'user', parts: [{text: 'hello'}]};
  const mockRequestContext = {
    contextId: 'req-ctx-123',
  } as RequestContext;

  it('creates context with session', () => {
    const mockSession = createSession({
      id: 'session-123',
      userId: 'user-1',
      appName: 'agent-1',
      state: {key: 'value'},
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hi'}]},
        }),
      ],
    });

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
});
