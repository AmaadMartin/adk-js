/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/environment_simulation/test_environment_simulation_factory.py
// at google/adk-python@main.

import {
  EnvironmentSimulationEngine,
  EnvironmentSimulationFactory,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
} from './simulation_test_support.js';

function createConfig() {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'test_tool',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
    simulationModel: FAKE_SIMULATION_MODEL,
    simulationModelConfiguration: {},
  });
}

describe('EnvironmentSimulationFactory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_create_callback', async () => {
    const simulate = vi
      .spyOn(EnvironmentSimulationEngine.prototype, 'simulate')
      .mockResolvedValue(undefined);
    const config = createConfig();

    const callback = EnvironmentSimulationFactory.createCallback(config);
    expect(typeof callback).toBe('function');

    const tool = new FakeTool({name: 'test_tool'});
    const context = createToolContext();
    await callback({tool, args: {}, context});

    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledWith({
      tool,
      args: {},
      toolContext: context,
    });
  });

  it('test_create_plugin', async () => {
    const simulate = vi
      .spyOn(EnvironmentSimulationEngine.prototype, 'simulate')
      .mockResolvedValue({mocked: true});
    const config = createConfig();

    const plugin = EnvironmentSimulationFactory.createPlugin(config);
    expect(plugin.name).toBe('EnvironmentSimulation');

    const tool = new FakeTool({name: 'test_tool'});
    const toolContext = createToolContext();
    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext,
    });

    expect(result).toEqual({mocked: true});
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledWith({tool, args: {}, toolContext});
  });
});
