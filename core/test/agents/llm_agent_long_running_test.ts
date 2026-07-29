/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  getFunctionCalls,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'test_app';
const USER_ID = 'user_1';

class MockLlm extends BaseLlm {
  callCount = 0;

  constructor(private readonly response: LlmResponse) {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.callCount++ === 0) {
      yield this.response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('LlmAgent with a pausing long running tool', () => {
  it('should stop after a long-running tool pauses with recorded state', async () => {
    // The human-in-the-loop pattern: the tool records its intent and returns
    // nothing, and the real function response is injected later by the client.
    const pausingTool = new LongRunningFunctionTool({
      name: 'pausing_tool',
      description: 'pauses for an out-of-band response',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        if (toolContext) {
          toolContext.state.set('pending', true);
          toolContext.actions.skipSummarization = true;
        }
        return null;
      },
    });
    const mockLlm = new MockLlm({
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'pausing_tool', args: {}, id: 'c_1'}}],
      },
    });
    const agent = new LlmAgent({
      name: 'pausing_agent',
      model: mockLlm,
      tools: [pausingTool],
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {parts: [{text: 'start'}]},
    })) {
      events.push(event);
    }

    // No extra model round-trip: the run stops on the paused tool call.
    expect(mockLlm.callCount).toBe(1);
    expect(events.length).toBe(2);
    expect(getFunctionCalls(events[0])[0].name).toBe('pausing_tool');

    const actionsOnlyEvent = events[1];
    expect(actionsOnlyEvent.content).toBeUndefined();
    expect(actionsOnlyEvent.longRunningToolIds).toEqual(['c_1']);

    const persisted = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(persisted!.state['pending']).toBe(true);
  });
});
