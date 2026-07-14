/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('InvocationContext.shouldPauseInvocation', () => {
  function createTestContext(events: Event[] = []): InvocationContext {
    const agent = new LlmAgent({name: 'test_agent', description: 'Agent'});
    const session = createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      events: [],
    });
    for (const e of events) {
      session.events.push(e);
    }
    return new InvocationContext({
      invocationId: 'inv_test',
      agent,
      session,
      pluginManager: new PluginManager(),
    });
  }

  it('returns false for events without longRunningToolIds', () => {
    const context = createTestContext();
    const event = createEvent({
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('returns false when longRunningToolIds is non-empty but event has no function calls', () => {
    const context = createTestContext();
    const event = createEvent({
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
      longRunningToolIds: ['adk-1'],
    });

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('returns true for events with active longRunningToolIds not resolved in session history', () => {
    const context = createTestContext();
    const event = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-1',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-1'],
    });
    context.session.events.push(event);

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('returns false when longRunningToolIds are resolved by subsequent user event in sub-branch', () => {
    const toolCallEvent = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-1',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-1'],
    });

    const userResumeEvent = createEvent({
      id: 'event-2',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'test_agent.long_tool@adk-1',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'long_tool',
              response: {status: 'done'},
              id: 'adk-1',
            },
          },
        ],
      },
    });

    const context = createTestContext([toolCallEvent, userResumeEvent]);
    expect(context.shouldPauseInvocation(toolCallEvent)).toBe(false);
  });

  it('handles branch run ID extraction edge cases when checking sub-branch resolution', () => {
    const toolCallEvent = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-2',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-2'],
    });

    const userResumeWithMultiBranch = createEvent({
      id: 'event-2',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'parent@run1.tool@adk-2.child@run3',
      content: {
        role: 'user',
        parts: [{text: 'resumed'}],
      },
    });

    const context = createTestContext([
      toolCallEvent,
      userResumeWithMultiBranch,
    ]);
    expect(context.shouldPauseInvocation(toolCallEvent)).toBe(false);

    const userResumeWithEmptyBranch = createEvent({
      id: 'event-3',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'parent.tool@',
      content: {
        role: 'user',
        parts: [{text: 'resumed'}],
      },
    });

    const context2 = createTestContext([
      toolCallEvent,
      userResumeWithEmptyBranch,
    ]);
    expect(context2.shouldPauseInvocation(toolCallEvent)).toBe(true);
  });
});
