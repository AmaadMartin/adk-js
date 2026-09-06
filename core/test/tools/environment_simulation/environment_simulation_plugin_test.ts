/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_plugin.py`
 * from google/adk-python (`main`, commit `c7ef8cfa`). Every `it` title is the
 * name of the reference test it ports.
 *
 * adk-python asserts that the plugin awaited `engine.simulate(tool, args,
 * context)` on a mock engine. adk-js drives a real engine whose injection rule
 * matches on the arguments, so the assertion still fails unless all three
 * values reach the engine.
 */

import {
  EnvironmentSimulationEngine,
  EnvironmentSimulationPlugin,
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

describe('EnvironmentSimulationPlugin', () => {
  it('test_before_tool_callback', async () => {
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs: {param: 'value'},
                injectedResponse: {injected: true},
              }),
            ],
          }),
        ],
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {},
      }),
    );
    const plugin = new EnvironmentSimulationPlugin(engine);

    const result = await plugin.beforeToolCallback({
      tool: new UncallableTool('test_tool'),
      toolArgs: {param: 'value'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({injected: true});
    expect(plugin.name).toBe('EnvironmentSimulation');
  });
});
