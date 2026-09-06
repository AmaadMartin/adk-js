/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_factory.py`
 * from google/adk-python (`main`, commit `c7ef8cfa`). Every `it` title is the
 * name of the reference test it ports. The own tests live in
 * `environment_simulation_factory_own_test.ts`.
 *
 * adk-python patches `EnvironmentSimulationEngine` and asserts it was
 * constructed once with the config. adk-js has no engine to patch, so each test
 * asserts what the built callback or plugin does instead.
 */

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationFactory,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  UncallableTool,
  createToolContext,
} from './simulation_test_support.js';

function simulationConfig(): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'test_tool',
        injectionConfigs: [
          createInjectionConfig({injectedResponse: {injected: true}}),
        ],
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
    simulationModel: FAKE_SIMULATION_MODEL,
    simulationModelConfiguration: {},
  });
}

describe('EnvironmentSimulationFactory', () => {
  it('test_create_callback', async () => {
    const callback =
      EnvironmentSimulationFactory.createCallback(simulationConfig());

    expect(typeof callback).toBe('function');
    const result = await callback({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });

  it('test_create_plugin', async () => {
    const plugin =
      EnvironmentSimulationFactory.createPlugin(simulationConfig());

    expect(plugin.name).toBe('EnvironmentSimulation');
    const result = await plugin.beforeToolCallback({
      tool: new UncallableTool('test_tool'),
      toolArgs: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });
});
