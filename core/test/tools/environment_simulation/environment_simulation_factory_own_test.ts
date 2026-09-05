/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests that both factory methods build exactly one engine and share it.
 *
 * An engine per call would silently disable stateful mocking, because the state
 * store and the "have I analyzed the tools yet" flag live on the engine.
 */

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationFactory,
  LlmAgent,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  UncallableTool,
  capturedRequests,
  createToolContext,
  scriptModelCalls,
} from './simulation_test_support.js';

const CONNECTION_MAP_JSON =
  '{"statefulParameters": [{"parameterName": "ticketId",' +
  ' "creatingTools": ["create_ticket"], "consumingTools": ["get_ticket"]}]}';

function statefulConfig(): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'create_ticket',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
      createToolSimulationConfig({
        toolName: 'get_ticket',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
    simulationModel: FAKE_SIMULATION_MODEL,
    simulationModelConfiguration: {},
  });
}

function supportAgent(): LlmAgent {
  return new LlmAgent({
    name: 'support',
    model: FAKE_SIMULATION_MODEL,
    tools: [
      new UncallableTool('create_ticket'),
      new UncallableTool('get_ticket'),
    ],
  });
}

/** The prompt text of the model call at `index`. */
function promptAt(index: number): string {
  expect(capturedRequests.length).toBeGreaterThan(index);
  return capturedRequests[index].contents[0].parts?.[0].text ?? '';
}

describe('EnvironmentSimulationFactory engine sharing', () => {
  it('reuses one engine across two calls of the returned callback', async () => {
    scriptModelCalls(
      [CONNECTION_MAP_JSON],
      ['{"ticketId": "T-1", "status": "open"}'],
      ['{"read": true}'],
    );
    const callback =
      EnvironmentSimulationFactory.createCallback(statefulConfig());
    const context = createToolContext(supportAgent());

    await callback({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context,
    });
    await callback({tool: new UncallableTool('get_ticket'), args: {}, context});

    // Three calls, not four: the analysis runs once for the shared engine, and
    // the second prompt carries the entity the first call created.
    expect(capturedRequests).toHaveLength(3);
    expect(promptAt(2)).toContain('"T-1"');
  });

  it('reuses one engine across two calls of the returned plugin', async () => {
    scriptModelCalls(
      [CONNECTION_MAP_JSON],
      ['{"ticketId": "T-2", "status": "open"}'],
      ['{"read": true}'],
    );
    const plugin = EnvironmentSimulationFactory.createPlugin(statefulConfig());
    const toolContext = createToolContext(supportAgent());

    await plugin.beforeToolCallback({
      tool: new UncallableTool('create_ticket'),
      toolArgs: {},
      toolContext,
    });
    await plugin.beforeToolCallback({
      tool: new UncallableTool('get_ticket'),
      toolArgs: {},
      toolContext,
    });

    expect(capturedRequests).toHaveLength(3);
    expect(promptAt(2)).toContain('"T-2"');
  });

  it('gives each factory call its own engine', async () => {
    scriptModelCalls(
      [CONNECTION_MAP_JSON],
      ['{"ticketId": "T-3", "status": "open"}'],
      [CONNECTION_MAP_JSON],
      ['{"read": true}'],
    );
    const context = createToolContext(supportAgent());

    const first = EnvironmentSimulationFactory.createCallback(statefulConfig());
    await first({tool: new UncallableTool('create_ticket'), args: {}, context});

    const second =
      EnvironmentSimulationFactory.createCallback(statefulConfig());
    await second({tool: new UncallableTool('get_ticket'), args: {}, context});

    // The second engine analyzes again and starts from an empty state store.
    expect(capturedRequests).toHaveLength(4);
    expect(promptAt(3)).not.toContain('"T-3"');
  });
});
