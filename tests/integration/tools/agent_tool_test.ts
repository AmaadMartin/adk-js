/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Runner,
  StreamingMode,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
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

/** A model that replays a script and records how the flow called it. */
class RecordingLlm extends BaseLlm {
  /** The `stream` argument of each call, in order. */
  readonly streamFlags: boolean[] = [];
  private index = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.streamFlags.push(stream === true);
    yield this.script[this.index++];
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

function modelText(value: string): LlmResponse {
  return {content: {role: 'model', parts: [{text: value}]}};
}

function modelCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {content: {role: 'model', parts: [{functionCall: {id, name, args}}]}};
}

/** A sub-agent whose answer costs two model calls, because it uses a tool. */
function createSubAgent(model: BaseLlm): LlmAgent {
  return new LlmAgent({
    model,
    name: 'subAgent',
    description: 'Reports the weather.',
    tools: [
      new FunctionTool({
        name: 'lookupWeather',
        description: 'Looks up the weather of a city.',
        parameters: z.object({city: z.string()}),
        execute: async () => ({weather: 'sunny'}),
      }),
    ],
  });
}

async function runParent(
  parentAgent: LlmAgent,
  runConfig: RunConfig,
): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: 'ADKTest',
    userId: 'TestUser',
    sessionId: '1',
  });
  const runner = new Runner({
    appName: 'ADKTest',
    agent: parentAgent,
    sessionService,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'TestUser',
    sessionId: '1',
    newMessage: {role: 'user', parts: [{text: 'What is the weather?'}]},
    runConfig,
  })) {
    events.push(event);
  }
  return events;
}

describe('AgentTool nested run config', () => {
  it('runs the nested agent unary while the caller streams', async () => {
    const subModel = new RecordingLlm([modelText('It is sunny in Tokyo.')]);
    const subAgent = new LlmAgent({
      model: subModel,
      name: 'subAgent',
      description: 'Reports the weather.',
    });
    const parentModel = new RecordingLlm([
      modelCall('call-1', 'subAgent', {request: 'weather in Tokyo'}),
      modelText('The sub agent says it is sunny in Tokyo.'),
    ]);
    const parentAgent = new LlmAgent({
      model: parentModel,
      name: 'mainAgent',
      description: 'Asks the sub agent.',
      tools: [new AgentTool({agent: subAgent})],
    });

    const events = await runParent(parentAgent, {
      streamingMode: StreamingMode.SSE,
    });

    expect(parentModel.streamFlags).toEqual([true, true]);
    expect(subModel.streamFlags).toEqual([false]);
    const toolResponse = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse?.name === 'subAgent');
    expect(toolResponse?.functionResponse?.response).toEqual({
      result: 'It is sunny in Tokyo.',
    });
  });

  it('applies the caller llm-call ceiling to the nested run', async () => {
    const subModel = new RecordingLlm([
      modelCall('call-2', 'lookupWeather', {city: 'Tokyo'}),
      modelText('It is sunny in Tokyo.'),
    ]);
    const parentModel = new RecordingLlm([
      modelCall('call-1', 'subAgent', {request: 'weather in Tokyo'}),
      modelText('The sub agent says it is sunny in Tokyo.'),
    ]);
    const parentAgent = new LlmAgent({
      model: parentModel,
      name: 'mainAgent',
      description: 'Asks the sub agent.',
      tools: [new AgentTool({agent: createSubAgent(subModel)})],
    });

    const events = await runParent(parentAgent, {maxLlmCalls: 1});

    expect(subModel.streamFlags).toHaveLength(1);
    expect(events.map((event) => event.errorMessage)).toContain(
      'Max number of llm calls limit of 1 exceeded',
    );
  });
});
