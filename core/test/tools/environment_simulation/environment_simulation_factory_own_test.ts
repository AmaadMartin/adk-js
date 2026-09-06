/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationFactory,
  FeatureName,
  LlmAgent,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
  recordedRequests,
  resetFakeModel,
  scriptModelAnswer,
} from './simulation_test_support.js';

/** A config whose tool is mocked from its declaration on every call. */
function createMockingConfig(): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'create_ticket',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
    simulationModel: FAKE_SIMULATION_MODEL,
    simulationModelConfiguration: {},
  });
}

describe('EnvironmentSimulationFactory feature gate', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, true);
  });

  it('createCallback throws when the feature is disabled', () => {
    const config = createMockingConfig();
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

    expect(() => EnvironmentSimulationFactory.createCallback(config)).toThrow(
      'Feature ENVIRONMENT_SIMULATION is not enabled.',
    );
  });

  it('createPlugin throws when the feature is disabled', () => {
    const config = createMockingConfig();
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

    expect(() => EnvironmentSimulationFactory.createPlugin(config)).toThrow(
      'Feature ENVIRONMENT_SIMULATION is not enabled.',
    );
  });
});

describe('EnvironmentSimulationFactory engine lifetime', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('one callback keeps one engine, so its state store survives', async () => {
    // The tools are analyzed once, then two creating calls land in one store.
    scriptModelAnswer(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools": []}]}',
    );
    scriptModelAnswer('{"ticket_id": "T-1"}');
    scriptModelAnswer('{"ticket_id": "T-2"}');

    const callback = EnvironmentSimulationFactory.createCallback(
      createMockingConfig(),
    );
    const tool = new FakeTool({name: 'create_ticket'});
    const context = createToolContext(
      new LlmAgent({
        name: 'test_agent',
        model: FAKE_SIMULATION_MODEL,
        tools: [tool],
      }),
    );

    await callback({tool, args: {}, context});
    await callback({tool, args: {}, context});

    // Three model calls: one analysis, then one per tool call. A second
    // analysis would mean a second engine.
    expect(recordedRequests).toHaveLength(3);
    const secondPrompt = recordedRequests[2].contents[0].parts?.[0].text ?? '';
    expect(secondPrompt).toContain('T-1');
  });

  it('two callbacks get independent engines', async () => {
    scriptModelAnswer('{"stateful_parameters": []}');
    scriptModelAnswer('{"ticket_id": "T-1"}');
    scriptModelAnswer('{"stateful_parameters": []}');
    scriptModelAnswer('{"ticket_id": "T-2"}');

    const tool = new FakeTool({name: 'create_ticket'});
    const context = createToolContext(
      new LlmAgent({
        name: 'test_agent',
        model: FAKE_SIMULATION_MODEL,
        tools: [tool],
      }),
    );

    await EnvironmentSimulationFactory.createCallback(createMockingConfig())({
      tool,
      args: {},
      context,
    });
    await EnvironmentSimulationFactory.createCallback(createMockingConfig())({
      tool,
      args: {},
      context,
    });

    // Each engine analyzes once, so the second callback analyzes again.
    expect(recordedRequests).toHaveLength(4);
  });

  it('createPlugin builds an engine the plugin reuses', async () => {
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        createToolSimulationConfig({
          toolName: 'get_weather',
          injectionConfigs: [
            createInjectionConfig({injectedResponse: {temperature: 21}}),
          ],
        }),
      ],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    const plugin = EnvironmentSimulationFactory.createPlugin(config);
    const result = await plugin.beforeToolCallback({
      tool: new FakeTool({name: 'get_weather'}),
      toolArgs: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({temperature: 21});
    // An injection-only config never resolves or calls a model.
    expect(recordedRequests).toHaveLength(0);
  });
});
