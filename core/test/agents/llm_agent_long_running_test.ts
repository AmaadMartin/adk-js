/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  Event,
  getFunctionCalls,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'test_app';
const USER_ID = 'user_1';

class MockLlm extends BaseLlm {
  callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.callCount];
    this.callCount++;
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/**
 * Creates a long-running tool that records something on its context and then
 * returns nothing, i.e. the human-in-the-loop pattern where the real function
 * response is injected later by the client.
 */
function createPausingTool(
  name: string,
  record: (toolContext: Context) => void,
) {
  return new LongRunningFunctionTool({
    name,
    description: name,
    parameters: z.object({}),
    execute: async (_args, toolContext) => {
      if (toolContext) {
        record(toolContext);
      }
      return null;
    },
  });
}

function toolCallResponse(toolName: string): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{functionCall: {name: toolName, args: {}, id: 'call_1'}}],
    },
  };
}

describe('LlmAgent with a pausing long running tool', () => {
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
  });

  async function run(
    agent: LlmAgent,
  ): Promise<{events: Event[]; sessionId: string}> {
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
    return {events, sessionId: session.id};
  }

  it('should stop after a long-running tool pauses with recorded state', async () => {
    const pausingTool = createPausingTool('pausing_tool', (toolContext) => {
      toolContext.state.set('pending', true);
      toolContext.actions.skipSummarization = true;
    });
    const mockLlm = new MockLlm([toolCallResponse('pausing_tool')]);
    const agent = new LlmAgent({
      name: 'pausing_agent',
      model: mockLlm,
      tools: [pausingTool],
    });

    const {events, sessionId} = await run(agent);

    // No extra model round-trip: the run stops on the paused tool call.
    expect(mockLlm.callCount).toBe(1);
    expect(events.length).toBe(2);
    expect(getFunctionCalls(events[0])[0].name).toBe('pausing_tool');

    const actionsOnlyEvent = events[1];
    expect(actionsOnlyEvent.content).toBeUndefined();
    expect(actionsOnlyEvent.actions.stateDelta).toEqual({pending: true});
    expect(actionsOnlyEvent.actions.skipSummarization).toBe(true);
    expect(actionsOnlyEvent.longRunningToolIds).toEqual(['call_1']);

    const persisted = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId,
    });
    expect(persisted!.state['pending']).toBe(true);
  });

  it('should not append an extra event when a long-running tool pauses without recording actions', async () => {
    const silentTool = createPausingTool('silent_tool', () => {});
    const mockLlm = new MockLlm([toolCallResponse('silent_tool')]);
    const agent = new LlmAgent({
      name: 'silent_agent',
      model: mockLlm,
      tools: [silentTool],
    });

    const {events, sessionId} = await run(agent);

    expect(mockLlm.callCount).toBe(1);
    expect(events.length).toBe(1);
    expect(getFunctionCalls(events[0])[0].name).toBe('silent_tool');

    const persisted = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId,
    });
    expect(persisted!.state).toEqual({});
  });

  it('should persist an escalate action from a long-running tool that returns nothing', async () => {
    const escalatingTool = createPausingTool(
      'escalating_tool',
      (toolContext) => {
        toolContext.actions.escalate = true;
      },
    );
    const mockLlm = new MockLlm([toolCallResponse('escalating_tool')]);
    const agent = new LlmAgent({
      name: 'escalating_agent',
      model: mockLlm,
      tools: [escalatingTool],
    });

    const {events} = await run(agent);

    expect(mockLlm.callCount).toBe(1);
    expect(events.length).toBe(2);
    expect(events[1].actions.escalate).toBe(true);
  });
});
