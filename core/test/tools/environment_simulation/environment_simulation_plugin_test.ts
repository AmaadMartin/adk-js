/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_plugin.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports.
 */

import {
  EnvironmentSimulationEngine,
  EnvironmentSimulationPlugin,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeTool,
  installFakeLlm,
  makeToolContext,
} from './simulation_test_utils.js';

describe('EnvironmentSimulationPlugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFakeLlm('{}');
  });

  it('test_before_tool_callback', async () => {
    const engine = new EnvironmentSimulationEngine({
      toolSimulationConfigs: [],
      simulationModel: 'fake-model',
      simulationModelConfiguration: {},
    });
    const simulate = vi
      .spyOn(engine, 'simulate')
      .mockResolvedValue({simulated: true});
    const plugin = new EnvironmentSimulationPlugin(engine);
    const tool = new FakeTool('any_tool');
    const toolArgs = {};
    const toolContext = makeToolContext();

    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs,
      toolContext,
    });

    expect(simulate).toHaveBeenCalledExactlyOnceWith(
      tool,
      toolArgs,
      toolContext,
    );
    expect(result).toEqual({simulated: true});
  });

  it('reports the fixed adk-python plugin name', () => {
    const engine = new EnvironmentSimulationEngine({
      toolSimulationConfigs: [],
      simulationModel: 'fake-model',
      simulationModelConfiguration: {},
    });

    expect(new EnvironmentSimulationPlugin(engine).name).toBe(
      'EnvironmentSimulation',
    );
  });
});
