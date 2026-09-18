/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/environment_simulation/test_environment_simulation_plugin.py
// at google/adk-python@main.

import {
  EnvironmentSimulationEngine,
  EnvironmentSimulationPlugin,
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

describe('EnvironmentSimulationPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_before_tool_callback', async () => {
    const simulate = vi
      .spyOn(EnvironmentSimulationEngine.prototype, 'simulate')
      .mockResolvedValue(undefined);
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {},
      }),
    );
    const plugin = new EnvironmentSimulationPlugin(engine);

    const tool = new FakeTool({name: 'test_tool'});
    const toolArgs = {city: 'Munich'};
    const toolContext = createToolContext();
    await plugin.beforeToolCallback({tool, toolArgs, toolContext});

    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledWith({
      tool,
      args: toolArgs,
      toolContext,
    });
  });
});
