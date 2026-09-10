/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_plugin.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports. The own tests live in
 * `environment_simulation_plugin_own_test.ts`.
 *
 * adk-python passes the tool, the args and the context positionally; adk-js
 * passes one destructured params object, so the hook is called differently
 * while `simulate` still receives the same three values in the same order.
 */

import {
  BaseTool,
  Context,
  createSession,
  EnvironmentSimulationPlugin,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ToolCallSimulator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

interface RecordedCall {
  tool: BaseTool;
  args: Record<string, unknown>;
  toolContext: Context;
}

class RecordingSimulator implements ToolCallSimulator {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly result: Record<string, unknown> | undefined) {}

  async simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<Record<string, unknown> | undefined> {
    this.calls.push({tool, args, toolContext});
    return this.result;
  }
}

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({city, conditions: 'real'}),
});

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv_environment_simulation',
      session: createSession({id: 'session-1', appName: 'demo'}),
      agent: new LlmAgent({name: 'weather_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('EnvironmentSimulationPlugin', () => {
  it('test_before_tool_callback', async () => {
    const simulated = {temperature: 21};
    const simulator = new RecordingSimulator(simulated);
    const plugin = new EnvironmentSimulationPlugin(simulator);
    const tool = weatherTool;
    const toolArgs = {};
    const toolContext = createToolContext();

    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs,
      toolContext,
    });

    expect(simulator.calls).toHaveLength(1);
    expect(simulator.calls[0].tool).toBe(tool);
    expect(simulator.calls[0].args).toBe(toolArgs);
    expect(simulator.calls[0].toolContext).toBe(toolContext);
    expect(result).toBe(simulated);
  });
});
