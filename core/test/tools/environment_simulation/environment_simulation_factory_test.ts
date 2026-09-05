/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_factory.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports.
 *
 * adk-python patches `EnvironmentSimulationEngine` and
 * `EnvironmentSimulationPlugin` and asserts the constructor calls. adk-js
 * asserts on what the returned callback and plugin do instead, which pins the
 * same wiring without replacing the classes under test.
 */

import {
  createEnvironmentSimulationConfig,
  createToolSimulationConfig,
  EnvironmentSimulationConfig,
  EnvironmentSimulationFactory,
  MockStrategy,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeTool,
  installFakeLlm,
  makeToolContext,
} from './simulation_test_utils.js';

function makeConfig(): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig({
    simulationModel: 'fake-model',
    simulationModelConfiguration: {},
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'test_tool',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
  });
}

describe('EnvironmentSimulationFactory', () => {
  beforeEach(() => {
    installFakeLlm('{"mocked": true}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_create_callback', async () => {
    const callback = EnvironmentSimulationFactory.createCallback(makeConfig());

    expect(typeof callback).toBe('function');
    expect(
      await callback(new FakeTool('test_tool'), {}, makeToolContext()),
    ).toEqual({mocked: true});
    expect(
      await callback(new FakeTool('other_tool'), {}, makeToolContext()),
    ).toBeUndefined();
  });

  it('test_create_plugin', async () => {
    const plugin = EnvironmentSimulationFactory.createPlugin(makeConfig());

    expect(plugin.name).toBe('EnvironmentSimulation');
    expect(
      await plugin.beforeToolCallback({
        tool: new FakeTool('test_tool'),
        toolArgs: {},
        toolContext: makeToolContext(),
      }),
    ).toEqual({mocked: true});
  });

  it('gives each call its own engine, so no state store is shared', async () => {
    const config = makeConfig();

    const first = EnvironmentSimulationFactory.createPlugin(config);
    const second = EnvironmentSimulationFactory.createPlugin(config);

    expect(first).not.toBe(second);
  });
});
