/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationEngine,
  EnvironmentSimulationPlugin,
  MockStrategy,
  SequentialAgent,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  StubTool,
  createToolContext,
  stubRegistryWithText,
} from './environment_simulation_test_utils.js';

const TOOL = new StubTool('create_ticket', {
  name: 'create_ticket',
  description: 'Creates a ticket.',
});

let engine: EnvironmentSimulationEngine;
let plugin: EnvironmentSimulationPlugin;

describe('EnvironmentSimulationPlugin', () => {
  beforeEach(() => {
    stubRegistryWithText(['{}']);
    engine = new EnvironmentSimulationEngine({
      toolSimulationConfigs: [
        {
          toolName: 'create_ticket',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
      simulationModel: 'test-model',
      simulationModelConfiguration: {},
    });
    plugin = new EnvironmentSimulationPlugin(engine);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered under the cross-language plugin name', () => {
    expect(plugin.name).toBe('EnvironmentSimulation');
  });

  it('delegates a tool call to the engine exactly once and returns its result', async () => {
    const simulate = vi
      .spyOn(engine, 'simulate')
      .mockResolvedValue({mocked: true});
    const toolContext = createToolContext(new SequentialAgent({name: 'root'}));
    const toolArgs = {title: 'Printer on fire'};

    const result = await plugin.beforeToolCallback({
      tool: TOOL,
      toolArgs,
      toolContext,
    });

    expect(result).toEqual({mocked: true});
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledWith({
      tool: TOOL,
      args: toolArgs,
      toolContext,
    });
  });

  it('passes an undefined result through so the real tool runs', async () => {
    vi.spyOn(engine, 'simulate').mockResolvedValue(undefined);

    const result = await plugin.beforeToolCallback({
      tool: TOOL,
      toolArgs: {},
      toolContext: createToolContext(new SequentialAgent({name: 'root'})),
    });

    expect(result).toBeUndefined();
  });
});
