/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EnvironmentSimulationFactory,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MockStrategy,
  Runner,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {Part} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  FAKE_SIMULATION_MODEL,
  resetFakeModel,
  scriptModelAnswer,
} from './simulation_test_support.js';

/** A model that answers each turn with the parts it was given. */
class ScriptedAgentLlm extends BaseLlm {
  private turn = 0;

  constructor(private readonly turns: Part[][]) {
    super({model: 'scripted-agent-model'});
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const parts = this.turns[this.turn] ?? [{text: 'done'}];
    this.turn++;
    yield {content: {role: 'model', parts}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The scripted agent model has no live connection.');
  }
}

/** Collects the tool results a run produced, keyed by tool name. */
function collectToolResults(events: Event[]): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.name) {
        results[part.functionResponse.name] = part.functionResponse.response;
      }
    }
  }
  return results;
}

async function runAgent(agent: LlmAgent): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'u1',
  });
  const runner = new Runner({appName: 'test_app', agent, sessionService});

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'weather in Munich please'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('environment simulation through a real agent run', () => {
  let realCalls: string[] = [];

  beforeEach(() => {
    resetFakeModel();
    realCalls = [];
  });

  function createWeatherTool(): FunctionTool<z.ZodObject<{city: z.ZodString}>> {
    return new FunctionTool({
      name: 'get_weather',
      description: 'Reports the current weather in a city.',
      parameters: z.object({city: z.string()}),
      execute: ({city}) => {
        realCalls.push('get_weather');
        return {city, conditions: 'sunny'};
      },
    });
  }

  function createTicketTool(): FunctionTool<
    z.ZodObject<{summary: z.ZodString}>
  > {
    return new FunctionTool({
      name: 'create_ticket',
      description: 'Opens a support ticket and returns its id.',
      parameters: z.object({summary: z.string()}),
      execute: ({summary}) => {
        realCalls.push('create_ticket');
        return {ticket_id: 'REAL-1', summary};
      },
    });
  }

  it('answers an injected tool call without running the real tool', async () => {
    const agent = new LlmAgent({
      name: 'support_agent',
      model: new ScriptedAgentLlm([
        [
          {
            functionCall: {
              id: 'fc-1',
              name: 'get_weather',
              args: {city: 'Munich'},
            },
          },
        ],
        [{text: 'The weather service could not find that city.'}],
      ]),
      tools: [createWeatherTool()],
      beforeToolCallback: EnvironmentSimulationFactory.createCallback(
        createEnvironmentSimulationConfig({
          toolSimulationConfigs: [
            createToolSimulationConfig({
              toolName: 'get_weather',
              injectionConfigs: [
                createInjectionConfig({
                  injectedError: createInjectedError({
                    injectedHttpErrorCode: 404,
                    errorMessage: 'City not found.',
                  }),
                }),
              ],
            }),
          ],
          simulationModel: FAKE_SIMULATION_MODEL,
          simulationModelConfiguration: {},
        }),
      ),
    });

    const results = collectToolResults(await runAgent(agent));

    expect(results['get_weather']).toEqual({
      error_code: 404,
      error_message: 'City not found.',
    });
    expect(realCalls).toEqual([]);
  });

  it('answers a mocked tool call with the model-generated response', async () => {
    scriptModelAnswer('{"stateful_parameters": []}');
    scriptModelAnswer('{"ticket_id": "SIM-7", "status": "open"}');

    const agent = new LlmAgent({
      name: 'support_agent',
      model: new ScriptedAgentLlm([
        [
          {
            functionCall: {
              id: 'fc-1',
              name: 'create_ticket',
              args: {summary: 'Munich weather is missing'},
            },
          },
        ],
        [{text: 'I opened a ticket.'}],
      ]),
      tools: [createTicketTool()],
      beforeToolCallback: EnvironmentSimulationFactory.createCallback(
        createEnvironmentSimulationConfig({
          toolSimulationConfigs: [
            createToolSimulationConfig({
              toolName: 'create_ticket',
              mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
            }),
          ],
          simulationModel: FAKE_SIMULATION_MODEL,
          simulationModelConfiguration: {},
        }),
      ),
    });

    const results = collectToolResults(await runAgent(agent));

    expect(results['create_ticket']).toEqual({
      ticket_id: 'SIM-7',
      status: 'open',
    });
    expect(realCalls).toEqual([]);
  });

  it('runs the real tool when no config names it', async () => {
    const agent = new LlmAgent({
      name: 'support_agent',
      model: new ScriptedAgentLlm([
        [
          {
            functionCall: {
              id: 'fc-1',
              name: 'get_weather',
              args: {city: 'Munich'},
            },
          },
        ],
        [{text: 'It is sunny.'}],
      ]),
      tools: [createWeatherTool()],
      beforeToolCallback: EnvironmentSimulationFactory.createCallback(
        createEnvironmentSimulationConfig({
          toolSimulationConfigs: [
            createToolSimulationConfig({
              toolName: 'some_other_tool',
              mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
            }),
          ],
          simulationModel: FAKE_SIMULATION_MODEL,
          simulationModelConfiguration: {},
        }),
      ),
    });

    const results = collectToolResults(await runAgent(agent));

    expect(results['get_weather']).toEqual({
      city: 'Munich',
      conditions: 'sunny',
    });
    expect(realCalls).toEqual(['get_weather']);
  });

  it('serves every agent in the run when installed as a plugin', async () => {
    const agent = new LlmAgent({
      name: 'support_agent',
      model: new ScriptedAgentLlm([
        [
          {
            functionCall: {
              id: 'fc-1',
              name: 'get_weather',
              args: {city: 'Munich'},
            },
          },
        ],
        [{text: 'The weather service could not find that city.'}],
      ]),
      tools: [createWeatherTool()],
    });
    const plugin = EnvironmentSimulationFactory.createPlugin(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'get_weather',
            injectionConfigs: [
              createInjectionConfig({injectedResponse: {conditions: 'foggy'}}),
            ],
          }),
        ],
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {},
      }),
    );

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
      plugins: [plugin],
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'weather in Munich please'}]},
    })) {
      events.push(event);
    }

    expect(collectToolResults(events)['get_weather']).toEqual({
      conditions: 'foggy',
    });
    expect(realCalls).toEqual([]);
  });
});
