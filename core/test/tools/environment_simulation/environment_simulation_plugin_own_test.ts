/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js-only tests for `EnvironmentSimulationPlugin`. The tests ported from
 * google/adk-python live in `environment_simulation_plugin_test.ts`.
 */

import {
  BasePlugin,
  Context,
  createSession,
  EnvironmentSimulationPlugin,
  FeatureName,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  isFeatureEnabled,
  LlmAgent,
  overrideFeatureEnabled,
  PluginManager,
  ToolCallSimulator,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

class FixedSimulator implements ToolCallSimulator {
  constructor(private readonly result: Record<string, unknown> | undefined) {}

  async simulate(): Promise<Record<string, unknown> | undefined> {
    return this.result;
  }
}

class RejectingSimulator implements ToolCallSimulator {
  async simulate(): Promise<Record<string, unknown> | undefined> {
    throw new Error('simulator unavailable');
  }
}

/** A plugin that answers every tool call, so a short circuit is observable. */
class AlwaysAnsweringPlugin extends BasePlugin {
  constructor(private readonly result: Record<string, unknown>) {
    super('always_answering');
  }

  override async beforeToolCallback(): Promise<
    Record<string, unknown> | undefined
  > {
    return this.result;
  }
}

let weatherToolRuns = 0;

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => {
    weatherToolRuns++;
    return {city, conditions: 'real'};
  },
});

function createInvocationContext(plugins: BasePlugin[]): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_environment_simulation',
    session: createSession({id: 'session-1', appName: 'demo'}),
    agent: new LlmAgent({name: 'weather_agent', model: 'test_model'}),
    pluginManager: new PluginManager(plugins),
  });
}

function createToolContext(): Context {
  return new Context({invocationContext: createInvocationContext([])});
}

describe('EnvironmentSimulationPlugin own', () => {
  beforeEach(() => {
    weatherToolRuns = 0;
  });

  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
  });

  it('names itself EnvironmentSimulation', () => {
    const plugin = new EnvironmentSimulationPlugin(new FixedSimulator({}));

    expect(plugin.name).toBe('EnvironmentSimulation');
  });

  it('returns undefined when the simulator declines the call', async () => {
    const plugin = new EnvironmentSimulationPlugin(
      new FixedSimulator(undefined),
    );

    const result = await plugin.beforeToolCallback({
      tool: weatherTool,
      toolArgs: {city: 'Paris'},
      toolContext: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('propagates a rejection from the simulator', async () => {
    const plugin = new EnvironmentSimulationPlugin(new RejectingSimulator());

    await expect(
      plugin.beforeToolCallback({
        tool: weatherTool,
        toolArgs: {city: 'Paris'},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow('simulator unavailable');
  });

  it('throws when the ENVIRONMENT_SIMULATION feature is disabled', () => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

    expect(
      () => new EnvironmentSimulationPlugin(new FixedSimulator({})),
    ).toThrow(/Feature ENVIRONMENT_SIMULATION is not enabled/);
  });

  it('enables the ENVIRONMENT_SIMULATION feature by default', () => {
    expect(isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)).toBe(true);
  });

  it('short circuits the plugin chain only when the simulator answers', async () => {
    const fallback = {conditions: 'fallback'};
    const simulated = {conditions: 'simulated'};
    const answering = new PluginManager([
      new EnvironmentSimulationPlugin(new FixedSimulator(simulated)),
      new AlwaysAnsweringPlugin(fallback),
    ]);
    const declining = new PluginManager([
      new EnvironmentSimulationPlugin(new FixedSimulator(undefined)),
      new AlwaysAnsweringPlugin(fallback),
    ]);
    const params = {
      tool: weatherTool,
      toolArgs: {city: 'Paris'},
      toolContext: createToolContext(),
    };

    expect(await answering.runBeforeToolCallback(params)).toBe(simulated);
    expect(await declining.runBeforeToolCallback(params)).toBe(fallback);
  });

  it('answers a function call without running the real tool', async () => {
    const invocationContext = createInvocationContext([
      new EnvironmentSimulationPlugin(
        new FixedSimulator({city: 'Paris', conditions: 'simulated'}),
      ),
    ]);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc-1', name: 'get_weather', args: {city: 'Paris'}}],
      toolsDict: {'get_weather': weatherTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual({
      city: 'Paris',
      conditions: 'simulated',
    });
    expect(weatherToolRuns).toBe(0);
  });

  it('runs the real tool when the simulator declines the function call', async () => {
    const invocationContext = createInvocationContext([
      new EnvironmentSimulationPlugin(new FixedSimulator(undefined)),
    ]);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc-1', name: 'get_weather', args: {city: 'Paris'}}],
      toolsDict: {'get_weather': weatherTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual({
      city: 'Paris',
      conditions: 'real',
    });
    expect(weatherToolRuns).toBe(1);
  });
});
