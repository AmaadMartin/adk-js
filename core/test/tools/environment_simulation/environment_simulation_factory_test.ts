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
  LlmAgent,
  MockStrategy,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeTool,
  installFakeLlm,
  makeToolContext,
} from './simulation_test_utils.js';

/** The prompt line the state store is rendered under. */
const STATE_STORE_HEADING =
  'Here is the current state of all stateful parameters:';

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
      await callback({
        tool: new FakeTool('test_tool'),
        args: {},
        context: makeToolContext(),
      }),
    ).toEqual({mocked: true});
    expect(
      await callback({
        tool: new FakeTool('other_tool'),
        args: {},
        context: makeToolContext(),
      }),
    ).toBeUndefined();
  });

  it('returns a callback an agent accepts as its beforeToolCallback', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'fake-model',
      beforeToolCallback:
        EnvironmentSimulationFactory.createCallback(makeConfig()),
    });

    const [callback] = agent.canonicalBeforeToolCallbacks;

    expect(
      await callback({
        tool: new FakeTool('test_tool'),
        args: {},
        context: makeToolContext(),
      }),
    ).toEqual({mocked: true});
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
    const fakeLlm = installFakeLlm(
      JSON.stringify({
        stateful_parameters: [
          {
            parameter_name: 'ticket_id',
            creating_tools: ['test_tool'],
            consuming_tools: [],
          },
        ],
        ticket_id: 'T-1',
      }),
    );
    const config = makeConfig();
    const agentContext = makeToolContext(
      new LlmAgent({
        name: 'test_agent',
        model: 'fake-model',
        tools: [new FakeTool('test_tool')],
      }),
    );
    const first = EnvironmentSimulationFactory.createPlugin(config);
    const second = EnvironmentSimulationFactory.createPlugin(config);
    const call = {
      tool: new FakeTool('test_tool'),
      toolArgs: {},
      toolContext: agentContext,
    };

    await first.beforeToolCallback(call);
    await first.beforeToolCallback(call);
    const secondCallOfFirst = fakeLlm.lastPrompt;
    await second.beforeToolCallback(call);
    const firstCallOfSecond = fakeLlm.lastPrompt;

    // The same plugin sees the entity its earlier call created, so an empty
    // state store in the other plugin means the two do not share one.
    expect(secondCallOfFirst).toContain(`${STATE_STORE_HEADING}\n  {\n`);
    expect(firstCallOfSecond).toContain(`${STATE_STORE_HEADING}\n  {}`);
  });
});
