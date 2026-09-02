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
  Session,
  StreamingMode,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const APP_NAME = 'ADKTest';
const USER_ID = 'TestUser';
const SESSION_ID = '1';

function textReply(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

function toolCall(id: string, request: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          parts: [{functionCall: {name: 'subAgent', args: {request}, id}}],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/** The text of every model turn the parent agent produced. */
function modelTexts(session: Session): string[] {
  return session.events
    .filter((event) => event.content?.role === 'model')
    .flatMap((event) => event.content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined);
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
  it('validates the schema-typed sub-agent call in both directions', async () => {
    const subAgentModel = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              parts: [{text: '{"summary": "three pairs found", "count": 3}'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ]);
    const requestedTexts: string[] = [];
    const subAgent = new LlmAgent({
      model: subAgentModel,
      name: 'searchAgent',
      description: 'searches the catalogue',
      instruction: 'search the catalogue',
      inputSchema: z.object({query: z.string(), limit: z.number()}),
      outputSchema: z.object({summary: z.string(), count: z.number()}),
      beforeModelCallback: ({request}) => {
        for (const content of request.contents ?? []) {
          for (const part of content.parts ?? []) {
            if (part.text) {
              requestedTexts.push(part.text);
            }
          }
        }
        return undefined;
      },
    });

    const mainAgentModel = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'searchAgent',
                    args: {query: 'running shoes', limit: 3},
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
              parts: [{text: 'I found three pairs.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ]);
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use searchAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
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

    const responses: unknown[] = [];
    for await (const event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'Find me running shoes'}]},
    })) {
      for (const part of event.content?.parts ?? []) {
        if (part.functionResponse) {
          responses.push(part.functionResponse.response);
        }
      }
    }

    expect(requestedTexts).toContain('{"query":"running shoes","limit":3}');
    expect(responses).toEqual([{summary: 'three pairs found', count: 3}]);
  });

  it('runs the sub-agent twice without writing to the parent session service', async () => {
    const subAgent = new LlmAgent({
      model: new GeminiWithMockResponses([
        textReply('Today is Tuesday'),
        textReply('Tomorrow is Wednesday'),
      ]),
      name: 'subAgent',
      description: 'answers calendar questions',
      instruction: 'answer the question',
    });

    const mainAgent = new LlmAgent({
      model: new GeminiWithMockResponses([
        toolCall('adk-mock-call-1', 'what day is today'),
        toolCall('adk-mock-call-2', 'what day is tomorrow'),
        textReply('Tuesday, then Wednesday.'),
      ]),
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const runner = new Runner({
      appName: APP_NAME,
      agent: mainAgent,
      sessionService,
    });

    for await (const _event of runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'What day is it?'}]},
    })) {
      // Consume the events.
    }

    const listed = await sessionService.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.sessions.map((session) => session.id)).toEqual([SESSION_ID]);

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session).toBeDefined();

    const texts = modelTexts(session!);
    expect(texts).toContain('Tuesday, then Wednesday.');

    const responses = session!.events
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.functionResponse?.response)
      .filter((response) => response !== undefined);
    expect(responses).toEqual([
      {result: 'Today is Tuesday'},
      {result: 'Tomorrow is Wednesday'},
    ]);
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
    // The nested run produced no content, so the tool reports why it stopped
    // rather than an empty result.
    expect(response).toEqual({
      result: 'Max number of llm calls limit of 2 exceeded',
    });
  });

  it('lets the nested run finish under the default ceiling', async () => {
    const {parent, subAgentCalls} = createParentOverSubAgent();

    const response = await runAndReadSubAgentResponse(parent);

    expect(subAgentCalls()).toBe(3);
    expect(response).toEqual({result: 'Today is Tuesday'});
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
