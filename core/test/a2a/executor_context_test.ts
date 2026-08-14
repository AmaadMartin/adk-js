/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {
  Event as AdkEvent,
  BaseAgent,
  InMemorySessionService,
  InvocationContext,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createExecutorContext} from '../../src/a2a/executor_context.js';

class SilentAgent extends BaseAgent {
  constructor() {
    super({name: 'silent_agent'});
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {}

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {}
}

describe('createExecutorContext', () => {
  const mockUserContent: Content = {role: 'user', parts: [{text: 'hello'}]};
  const mockRequestContext = {
    contextId: 'req-ctx-123',
  } as RequestContext;
  const runner = new Runner({
    appName: 'agent-1',
    agent: new SilentAgent(),
    sessionService: new InMemorySessionService(),
  });

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
      runner,
    });

    expect(context).toEqual({
      userId: 'user-1',
      sessionId: 'session-123',
      appName: 'agent-1',
      readonlyState: {key: 'value'},
      events: mockSession.events,
      userContent: mockUserContent,
      requestContext: mockRequestContext,
      runner,
    });
  });
});
