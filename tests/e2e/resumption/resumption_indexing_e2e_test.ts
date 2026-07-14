/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {syncSessionResumptionIndex} from '../../../core/src/runner/runner.js';

class E2eScriptedLlm extends BaseLlm {
  private turnCount = 0;
  private responsesByTurn: Record<number, Content>;

  constructor(responsesByTurn: Record<number, Content>) {
    super({model: 'e2e-scripted-llm'});
    this.responsesByTurn = responsesByTurn;
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect not needed for E2eScriptedLlm');
  }

  override async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.turnCount++;
    const content =
      this.responsesByTurn[this.turnCount] ||
      ({
        role: 'model',
        parts: [{text: `Default turn ${this.turnCount}`}],
      } as Content);

    yield {
      content,
    };
  }
}

describe('E2E Resumption Indexing and Subagent Routing without Mocks', () => {
  it('should route multi-turn conversations across sub-agents and tool calls seamlessly using SessionResumptionIndex', async () => {
    const helperTool = new FunctionTool({
      name: 'fetch_data',
      description: 'Fetches some data',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {type: 'STRING'},
        },
      },
      execute: async ({query}) => {
        return {result: `Fetched: ${query}`};
      },
    });

    const subAgentLlm = new E2eScriptedLlm({
      1: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc_e2e_1',
              name: 'fetch_data',
              args: {query: 'hello'},
            } as FunctionCall,
          },
        ],
      },
      2: {
        role: 'model',
        parts: [{text: 'SubAgent finalized after tool check'}],
      },
    });

    const subAgent = new LlmAgent({
      name: 'sub_agent',
      description: 'A sub-agent that executes data fetches.',
      instruction: 'You fetch data when needed.',
      model: subAgentLlm,
      tools: [helperTool],
    });

    const rootAgentLlm = new E2eScriptedLlm({
      1: {
        role: 'model',
        parts: [{text: 'Root agent responding initially'}],
      },
    });

    const rootAgent = new LlmAgent({
      name: 'root_agent',
      description: 'The root orchestrator.',
      instruction: 'Delegate to sub_agent when data is requested.',
      model: rootAgentLlm,
      subAgents: [subAgent],
    });

    const runner = new InMemoryRunner({
      agent: rootAgent,
      appName: 'e2e_resumption_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_resumption_app',
      userId: 'e2e_user',
    });

    // Turn 1: User talks to root agent
    const eventsTurn1 = [];
    for await (const ev of runner.runAsync({
      userId: 'e2e_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hi root agent'}]},
    })) {
      await runner.sessionService.appendEvent({session, event: ev});
      eventsTurn1.push(ev);
    }
    expect(eventsTurn1.length).toBeGreaterThan(0);
    expect(eventsTurn1[0].author).toBe('root_agent');

    const indexAfterTurn1 = syncSessionResumptionIndex(session);
    expect(indexAfterTurn1.lastIndexedLength).toBe(session.events.length);
    expect(indexAfterTurn1.agentEventIndices.length).toBeGreaterThan(0);

    // Now manually append an event from sub_agent calling a function (as if root delegated or sub_agent ran previously)
    await runner.sessionService.appendEvent({
      session,
      event: {
        id: 'ev_sub_call',
        invocationId: 'inv_sub',
        author: 'sub_agent',
        actions: {
          stateDelta: {},
          artifactDelta: {},
          requestedAuthConfigs: {},
          requestedToolConfirmations: {},
        },
        longRunningToolIds: [],
        timestamp: Date.now(),
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc_long_op',
                name: 'fetch_data',
                args: {query: 'background'},
              },
            },
          ],
        },
      },
    });

    // Turn 2: Run another turn. When the tool/user returns the functionResponse via newMessage in runAsync,
    // determineAgentForResumption must perform an O(1) lookup in SessionResumptionIndex and route directly to sub_agent!
    const eventsTurn2 = [];
    for await (const ev of runner.runAsync({
      userId: 'e2e_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc_long_op',
              name: 'fetch_data',
              response: {result: 'background data ready'},
            },
          },
        ],
      },
    })) {
      eventsTurn2.push(ev);
    }

    expect(eventsTurn2.length).toBeGreaterThan(0);
    expect(eventsTurn2[0].author).toBe('sub_agent');

    const finalIndex = syncSessionResumptionIndex(session);
    expect(finalIndex.functionCallEventMap.get('fc_long_op')?.author).toBe(
      'sub_agent',
    );
    expect(finalIndex.lastIndexedLength).toBe(session.events.length);
  });
});
