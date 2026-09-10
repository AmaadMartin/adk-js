/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment simulation: run an agent against simulated tools
 *
 * `get_weather` always fails with an injected 404. `book_flight` is mocked
 * from its own declaration by the simulation model. Neither function body
 * runs, so ask the agent to check the weather and book a flight and watch it
 * work against an environment that does not exist.
 *
 * REQUIRES an API key (the agent and the simulator both call a live model).
 * Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/plugins/environment_simulation/agent.ts
 */

import {
  App,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
  EnvironmentSimulationFactory,
  FunctionTool,
  LlmAgent,
  MockStrategy,
} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Reports the current weather in a city.',
  parameters: z.object({city: z.string().describe('The city to look up.')}),
  execute: ({city}) => ({city, temperature: 72, condition: 'Sunny'}),
});

const bookFlight = new FunctionTool({
  name: 'book_flight',
  description: 'Books a flight and returns its booking id.',
  parameters: z.object({
    destination: z.string().describe('Where the flight goes.'),
  }),
  execute: ({destination}) => ({destination, bookingId: 'FL-0001'}),
});

const simulationPlugin = EnvironmentSimulationFactory.createPlugin(
  createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'get_weather',
        injectionConfigs: [
          createInjectionConfig({
            injectedError: createInjectedError({
              injectedHttpErrorCode: 404,
              errorMessage: 'No weather station for that city.',
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

const travelAgent = new LlmAgent({
  name: 'travel_agent',
  model: 'gemini-flash-latest',
  instruction: `Help the user plan a trip. Use get_weather to check the
    weather and book_flight to book a flight. Report exactly what each tool
    returned, including any error.`,
  tools: [getWeather, bookFlight],
});

// The plugin is registered on the app, because a plugin belongs to the runner
// rather than to one agent.
export const app = new App({
  name: 'environment_simulation_sample',
  rootAgent: travelAgent,
  plugins: [simulationPlugin],
});
