/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BasePlugin,
  Context,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

/** Records the agents it ran for and how many times it was closed. */
class AgentTrackingPlugin extends BasePlugin {
  readonly agentsSeen: string[] = [];
  closeCount = 0;

  constructor() {
    super('agent-tracking-plugin');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
  }): Promise<undefined> {
    this.agentsSeen.push(params.callbackContext.agentName);
    return;
  }

  override async close(): Promise<void> {
    this.closeCount += 1;
  }
}

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

  it('returns the code and output of a code-executing sub-agent', async () => {
    const subAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {executableCode: {code: 'print(6 * 7)'}},
                {codeExecutionResult: {output: '42\n'}},
                {text: 'The answer is 42.'},
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const parentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'calculator',
                    args: {request: 'what is 6 times 7'},
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
            content: {parts: [{text: 'It is 42.'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const calculator = new LlmAgent({
      model: new GeminiWithMockResponses(subAgentResponses),
      name: 'calculator',
      description: 'Runs a calculation',
      instruction: 'compute what you are asked',
    });
    const mainAgent = new LlmAgent({
      model: new GeminiWithMockResponses(parentResponses),
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use the calculator to answer',
      tools: [new AgentTool({agent: calculator})],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService: new InMemoryMemoryService(),
    });

    const toolResponses: unknown[] = [];
    for await (const event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'What is 6 times 7?'}]},
    })) {
      for (const part of event.content?.parts ?? []) {
        if (part.functionResponse?.name === 'calculator') {
          toolResponses.push(part.functionResponse.response?.['result']);
        }
      }
    }

    expect(toolResponses).toEqual(['print(6 * 7)\n42\nThe answer is 42.']);
  });

  it("runs the caller's plugin for the wrapped agent without closing it", async () => {
    const subAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {parts: [{text: 'Today is Tuesday'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const parentResponses: RawGenerateContentResponse[] = [
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
            content: {parts: [{text: 'It is Tuesday.'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const subAgent = new LlmAgent({
      model: new GeminiWithMockResponses(subAgentResponses),
      name: 'subAgent',
      description: 'subAgent',
      instruction: 'answer what day is today',
    });
    const mainAgent = new LlmAgent({
      model: new GeminiWithMockResponses(parentResponses),
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const plugin = new AgentTrackingPlugin();
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService: new InMemoryMemoryService(),
      plugins: [plugin],
    });

    for await (const _event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'What day is today?'}]},
    })) {
      // Consume the events.
    }

    expect(plugin.agentsSeen).toContain('subAgent');
    expect(plugin.closeCount).toBe(0);

    await runner.close();

    expect(plugin.closeCount).toBe(1);
  });
});
