/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment simulation: serve tool calls from a simulated backend
 *
 * `get_weather` never runs. Every call to it returns the injected 404 instead.
 * `create_ticket` never runs either: a model invents a plausible response from
 * the tool's own declaration.
 *
 * Ask the agent for the weather in Munich, then ask it to open a ticket about
 * it, and watch neither real function execute.
 *
 * REQUIRES an API key, because the mocked tool calls a model. Set
 * GEMINI_API_KEY, then:
 *   npm run sample -- samples/tools/environment_simulation/agent.ts
 */

import {
  EnvironmentSimulationFactory,
  FunctionTool,
  LlmAgent,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Reports the current weather in a city.',
  parameters: z.object({city: z.string().describe('The city to report on.')}),
  execute: ({city}) => ({city, conditions: 'sunny', temperature: 21}),
});

const createTicket = new FunctionTool({
  name: 'create_ticket',
  description: 'Opens a support ticket and returns its id.',
  parameters: z.object({
    summary: z.string().describe('What the ticket is about.'),
  }),
  execute: ({summary}) => ({ticket_id: 'T-1', summary, status: 'open'}),
});

const simulationConfig = createEnvironmentSimulationConfig({
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
    createToolSimulationConfig({
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ],
});

export const rootAgent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-flash-latest',
  instruction:
    'You help with weather questions and open support tickets. Report tool' +
    ' errors to the user rather than retrying them.',
  tools: [getWeather, createTicket],
  beforeToolCallback:
    EnvironmentSimulationFactory.createCallback(simulationConfig),
});
