/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run an agent against a simulated tool
 *
 * `EnvironmentSimulationPlugin` asks a simulator for every tool call.
 * `WeatherSimulator` here is hand-written, because the model-backed engine
 * adk-python pairs with this plugin is a separate module that adk-js does not
 * have yet.
 *
 * Run:
 *   npm run sample -- samples/plugins/environment_simulation/agent.ts
 *
 * Ask for the weather in a city. The agent answers from the canned result and
 * never reaches the live service. Ask for the time instead and the real tool
 * runs, because the simulator declines that call.
 */

import {
  App,
  BaseTool,
  Context,
  EnvironmentSimulationPlugin,
  FunctionTool,
  LlmAgent,
  ToolCallSimulator,
} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({city, conditions: 'live service'}),
});

const getTime = new FunctionTool({
  name: 'get_time',
  description: 'Returns the current time.',
  parameters: z.object({}),
  execute: async () => ({time: new Date().toISOString()}),
});

class WeatherSimulator implements ToolCallSimulator {
  async simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    _toolContext: Context,
  ): Promise<Record<string, unknown> | undefined> {
    if (tool.name !== 'get_weather') {
      return undefined; // Run the real tool.
    }
    return {city: args['city'], conditions: 'sunny, 21C'};
  }
}

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer questions about the weather and the time. Call get_weather for' +
    ' weather and get_time for the time.',
  tools: [getWeather, getTime],
});

export const app = new App({
  name: 'environment_simulation',
  rootAgent: agent,
  plugins: [new EnvironmentSimulationPlugin(new WeatherSimulator())],
});
