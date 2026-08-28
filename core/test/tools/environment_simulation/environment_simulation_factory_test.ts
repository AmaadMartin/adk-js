/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationFactory,
  EnvironmentSimulationPlugin,
  LlmAgent,
  MockStrategyType,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  capturedRequests,
  createToolContext,
  FakeTool,
  resetScriptedModel,
  SCRIPTED_MODEL,
  scriptReply,
} from './simulation_test_utils.js';

function createConfig(): EnvironmentSimulationConfig {
  return {
    toolSimulationConfigs: [
      {
        toolName: 'create_ticket',
        mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
      },
    ],
    simulationModel: SCRIPTED_MODEL,
    simulationModelConfiguration: {},
  };
}

describe('EnvironmentSimulationFactory.createCallback', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('returns a callback an LlmAgent accepts', () => {
    const agent = new LlmAgent({
      name: 'support',
      model: SCRIPTED_MODEL,
      beforeToolCallback:
        EnvironmentSimulationFactory.createCallback(createConfig()),
    });

    expect(agent.beforeToolCallback).toBeTypeOf('function');
  });

  it('simulates the configured tool', async () => {
    scriptReply('{"ticket_id": "T-1"}');
    const callback =
      EnvironmentSimulationFactory.createCallback(createConfig());

    const result = await callback({
      tool: new FakeTool('create_ticket'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('lets an unconfigured tool run', async () => {
    const callback =
      EnvironmentSimulationFactory.createCallback(createConfig());

    const result = await callback({
      tool: new FakeTool('other_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('shares one engine, so a later call sees the earlier state', async () => {
    scriptReply(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools": []}]}',
    );
    scriptReply('{"ticket_id": "T-1"}');
    scriptReply('{"ticket_id": "T-2"}');
    const callback =
      EnvironmentSimulationFactory.createCallback(createConfig());
    const context = createToolContext(
      new LlmAgent({
        name: 'support',
        model: SCRIPTED_MODEL,
        tools: [new FakeTool('create_ticket')],
      }),
    );
    const call = {tool: new FakeTool('create_ticket'), args: {}, context};

    await callback(call);
    await callback(call);

    const secondPrompt = capturedRequests[2].contents[0].parts?.[0].text ?? '';
    expect(secondPrompt).toContain('"T-1"');
  });

  it('rejects an invalid config as it builds the callback', () => {
    expect(() =>
      EnvironmentSimulationFactory.createCallback({
        toolSimulationConfigs: [],
      }),
    ).toThrowError('toolSimulationConfigs must be provided.');
  });
});

describe('EnvironmentSimulationFactory.createPlugin', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('returns a plugin that simulates the configured tool', async () => {
    scriptReply('{"ticket_id": "T-1"}');
    const plugin = EnvironmentSimulationFactory.createPlugin(createConfig());

    expect(plugin).toBeInstanceOf(EnvironmentSimulationPlugin);
    expect(
      await plugin.beforeToolCallback({
        tool: new FakeTool('create_ticket'),
        toolArgs: {},
        toolContext: createToolContext(),
      }),
    ).toEqual({ticket_id: 'T-1'});
  });

  it('rejects an invalid config as it builds the plugin', () => {
    expect(() =>
      EnvironmentSimulationFactory.createPlugin({toolSimulationConfigs: []}),
    ).toThrowError('toolSimulationConfigs must be provided.');
  });
});
