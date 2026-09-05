/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the plugin through a real `Runner`, a real `LlmAgent` and a real
 * `FunctionTool`, so the whole path is exercised rather than the engine alone.
 * The two models are scripted `BaseLlm` subclasses registered in the
 * `LLMRegistry`, so no network call happens and nothing is mocked.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
  EnvironmentSimulationFactory,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  MockStrategy,
  Runner,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

const AGENT_MODEL = 'scripted-agent-model';
const SIMULATION_MODEL = 'scripted-simulation-model';

let weatherCallCount = 0;
let flightCallCount = 0;

/** Asks for one weather call and one flight call, then answers in text. */
class ScriptedAgentLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    AGENT_MODEL,
  ];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const answered = llmRequest.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse),
    );
    if (answered) {
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'call-1', name: 'get_weather', args: {}}},
          {functionCall: {id: 'call-2', name: 'book_flight', args: {}}},
        ],
      },
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedAgentLlm does not support a live connection.');
  }
}

/** Answers the analyzer and the tool-spec strategy with one JSON document. */
class ScriptedSimulationLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    SIMULATION_MODEL,
  ];

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [
          {
            text: JSON.stringify({
              stateful_parameters: [
                {
                  parameter_name: 'booking_id',
                  creating_tools: ['book_flight'],
                  consuming_tools: [],
                },
              ],
              booking_id: 'FL-1',
            }),
          },
        ],
      },
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedSimulationLlm does not support a live connection');
  }
}

function getWeather(): Record<string, unknown> {
  weatherCallCount += 1;
  return {temperature: 72};
}

function bookFlight(): Record<string, unknown> {
  flightCallCount += 1;
  return {booking_id: 'REAL-1'};
}

function functionResponses(events: Event[]): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.name) {
        responses[part.functionResponse.name] = part.functionResponse.response;
      }
    }
  }
  return responses;
}

describe('EnvironmentSimulationPlugin on a Runner', () => {
  beforeAll(() => {
    LLMRegistry.register(ScriptedAgentLlm);
    LLMRegistry.register(ScriptedSimulationLlm);
  });

  it('answers both tools from the simulation and runs neither for real', async () => {
    weatherCallCount = 0;
    flightCallCount = 0;
    const agent = new LlmAgent({
      name: 'travel_agent',
      model: AGENT_MODEL,
      tools: [
        new FunctionTool({
          name: 'get_weather',
          description: 'Reports the weather.',
          execute: getWeather,
        }),
        new FunctionTool({
          name: 'book_flight',
          description: 'Books a flight.',
          execute: bookFlight,
        }),
      ],
    });
    const plugin = EnvironmentSimulationFactory.createPlugin(
      createEnvironmentSimulationConfig({
        simulationModel: SIMULATION_MODEL,
        simulationModelConfiguration: {},
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'get_weather',
            injectionConfigs: [
              createInjectionConfig({
                injectedError: createInjectedError({
                  injectedHttpErrorCode: 404,
                  errorMessage: 'not found',
                }),
              }),
            ],
          }),
          createToolSimulationConfig({
            toolName: 'book_flight',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      }),
    );
    const runner = new Runner({
      appName: 'simulation-app',
      agent,
      plugins: [plugin],
      sessionService: new InMemorySessionService(),
    });

    const events: Event[] = [];
    for await (const event of runner.runEphemeral({
      userId: 'test-user',
      newMessage: {role: 'user', parts: [{text: 'plan my trip'}]},
    })) {
      events.push(event);
    }

    expect(functionResponses(events)).toEqual({
      get_weather: {error_code: 404, error_message: 'not found'},
      book_flight: {
        stateful_parameters: [
          {
            parameter_name: 'booking_id',
            creating_tools: ['book_flight'],
            consuming_tools: [],
          },
        ],
        booking_id: 'FL-1',
      },
    });
    expect(weatherCallCount).toBe(0);
    expect(flightCallCount).toBe(0);
  });

  it('runs a tool the configuration does not name', async () => {
    weatherCallCount = 0;
    flightCallCount = 0;
    const agent = new LlmAgent({
      name: 'travel_agent',
      model: AGENT_MODEL,
      tools: [
        new FunctionTool({
          name: 'get_weather',
          description: 'Reports the weather.',
          execute: getWeather,
        }),
        new FunctionTool({
          name: 'book_flight',
          description: 'Books a flight.',
          execute: bookFlight,
        }),
      ],
    });
    const plugin = EnvironmentSimulationFactory.createPlugin(
      createEnvironmentSimulationConfig({
        simulationModel: SIMULATION_MODEL,
        simulationModelConfiguration: {},
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'get_weather',
            injectionConfigs: [
              createInjectionConfig({injectedResponse: {temperature: 0}}),
            ],
          }),
        ],
      }),
    );
    const runner = new Runner({
      appName: 'simulation-app',
      agent,
      plugins: [plugin],
      sessionService: new InMemorySessionService(),
    });

    const events: Event[] = [];
    for await (const event of runner.runEphemeral({
      userId: 'test-user',
      newMessage: {role: 'user', parts: [{text: 'plan my trip'}]},
    })) {
      events.push(event);
    }

    expect(functionResponses(events)).toEqual({
      get_weather: {temperature: 0},
      book_flight: {booking_id: 'REAL-1'},
    });
    expect(weatherCallCount).toBe(0);
    expect(flightCallCount).toBe(1);
  });
});
