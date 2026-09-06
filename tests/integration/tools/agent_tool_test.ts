/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  FunctionTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  RunConfig,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('AgentTool', () => {
  it('propagates state changes from sub-agent to parent session', async () => {
    const mockSubAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Today is Tuesday'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const mockParentAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'subAgent',
                    args: {request: 'what day is today'},
                    id: 'adk-mock-call-1',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'The subAgent says it is Tuesday.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const subAgentModel = new GeminiWithMockResponses(mockSubAgentResponses);
    const subAgent = new LlmAgent({
      model: subAgentModel,
      name: 'subAgent',
      description: 'subAgent',
      instruction: 'answer what day is today',
      outputKey: 'subAgentOutput',
    });

    const mainAgentModel = new GeminiWithMockResponses(
      mockParentAgentResponses,
    );
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'testing you must use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();

    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      state: {initialStateKey: 'contexto inicial'},
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'What day is today?'}],
      },
    };

    for await (const _event of runner.runAsync(runOptions)) {
      // Consume the events.
    }

    const session = await sessionService.getSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    expect(session).toBeDefined();
    expect(session!.state['initialStateKey']).toBe('contexto inicial');
    expect(session!.state['subAgentOutput']).toBe('Today is Tuesday');
  });
});

/** A model turn that calls the `lookup` tool. */
function lookupCall(id: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          parts: [{functionCall: {name: 'lookup', args: {}, id}}],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/** A model turn that calls the `subAgent` tool. */
function subAgentCall(id: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'subAgent',
                args: {request: 'what day is today'},
                id,
              },
            },
          ],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/** A model turn that answers with text. */
function textTurn(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/** A parent agent, its sub-agent's model, and the runner setup for both. */
interface NestedAgents {
  parent: LlmAgent;
  /** Counts the sub-agent's model calls. */
  subAgentCalls: () => number;
}

/**
 * An agent that answers by calling a sub-agent as a tool.
 *
 * The parent needs two model calls. The sub-agent needs three: two tool
 * round-trips and a final answer.
 */
function createParentOverSubAgent(): NestedAgents {
  const subAgentModel = new GeminiWithMockResponses([
    lookupCall('sub-call-1'),
    lookupCall('sub-call-2'),
    textTurn('Today is Tuesday'),
  ]);
  const generate = vi.spyOn(subAgentModel, 'generateContentAsync');

  const subAgent = new LlmAgent({
    model: subAgentModel,
    name: 'subAgent',
    description: 'subAgent',
    tools: [
      new FunctionTool({
        name: 'lookup',
        description: 'looks a fact up',
        parameters: z.object({}),
        execute: async () => ({day: 'Tuesday'}),
      }),
    ],
  });

  const parent = new LlmAgent({
    model: new GeminiWithMockResponses([
      subAgentCall('main-call-1'),
      textTurn('The subAgent answered.'),
    ]),
    name: 'mainAgent',
    description: 'MainAgent',
    tools: [new AgentTool({agent: subAgent})],
  });

  return {parent, subAgentCalls: () => generate.mock.calls.length};
}

/** Runs `agent` under `runConfig` and returns the sub-agent's tool response. */
async function runAndReadSubAgentResponse(
  agent: LlmAgent,
  runConfig?: RunConfig,
): Promise<Record<string, unknown> | undefined> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: 'ADKTest',
    userId: 'TestUser',
    sessionId: '1',
  });
  const runner = new Runner({appName: 'ADKTest', agent, sessionService});

  let response: Record<string, unknown> | undefined;
  for await (const event of runner.runAsync({
    userId: 'TestUser',
    sessionId: '1',
    newMessage: {role: 'user', parts: [{text: 'What day is today?'}]},
    runConfig,
  })) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.name === 'subAgent') {
        response = part.functionResponse.response;
      }
    }
  }
  return response;
}

describe('AgentTool run config propagation', () => {
  it("bounds the nested run by the caller's maxLlmCalls", async () => {
    const {parent, subAgentCalls} = createParentOverSubAgent();

    const response = await runAndReadSubAgentResponse(parent, {maxLlmCalls: 2});

    expect(subAgentCalls()).toBe(2);
    expect(response).toEqual({result: ''});
  });

  it('lets the nested run finish under the default ceiling', async () => {
    const {parent, subAgentCalls} = createParentOverSubAgent();

    const response = await runAndReadSubAgentResponse(parent);

    expect(subAgentCalls()).toBe(3);
    expect(response).toEqual({result: 'Today is Tuesday'});
  });
});
