/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it} from 'vitest';

import {SimulationStateStore} from '../../../../src/tools/environment_simulation/strategies/base.js';
import {ToolSpecMockStrategy} from '../../../../src/tools/environment_simulation/strategies/tool_spec_mock_strategy.js';
import {ToolConnectionMap} from '../../../../src/tools/environment_simulation/tool_connection_map.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
  recordedRequests,
  resetFakeModel,
  scriptModelAnswer,
} from '../simulation_test_support.js';

function mock(params: {
  toolName?: string;
  stateStore?: SimulationStateStore;
  toolConnectionMap?: ToolConnectionMap;
  args?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return new ToolSpecMockStrategy({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  }).mock({
    tool: new FakeTool({name: params.toolName ?? 'create_ticket'}),
    args: params.args ?? {},
    toolContext: createToolContext(),
    toolConnectionMap: params.toolConnectionMap,
    stateStore: params.stateStore ?? {},
  });
}

describe('ToolSpecMockStrategy responses that are not JSON objects', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('reports a JSON array as an error, with the raw output', async () => {
    scriptModelAnswer('[1, 2]');

    expect(await mock({})).toEqual({
      status: 'error',
      error_message: 'Generated mock response was not a JSON object.',
      llm_output: '[1, 2]',
    });
  });

  it('reports a JSON null as an error', async () => {
    scriptModelAnswer('null');

    expect(await mock({})).toEqual({
      status: 'error',
      error_message: 'Generated mock response was not a JSON object.',
      llm_output: 'null',
    });
  });

  it('reports a JSON string as an error', async () => {
    scriptModelAnswer('"just text"');

    expect(await mock({})).toEqual({
      status: 'error',
      error_message: 'Generated mock response was not a JSON object.',
      llm_output: '"just text"',
    });
  });
});

describe('ToolSpecMockStrategy state store keys', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  const connectionMap: ToolConnectionMap = {
    statefulParameters: [
      {
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: [],
      },
    ],
  };

  it('finds the parameter inside an array in the response', async () => {
    scriptModelAnswer('{"tickets": [{"ticket_id": "T-9"}]}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore).toEqual({ticket_id: {'T-9': result}});
  });

  it('searches on when an array holds no match', async () => {
    scriptModelAnswer(
      '{"tickets": [{"other": 1}], "data": {"ticket_id": "T-13"}}',
    );
    const stateStore: SimulationStateStore = {};

    const result = await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore).toEqual({ticket_id: {'T-13': result}});
  });

  it('keys a numeric parameter value by its string form', async () => {
    scriptModelAnswer('{"ticket_id": 42}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore).toEqual({ticket_id: {'42': result}});
  });

  it('lets a null at the top level stand for the whole response', async () => {
    // adk-python returns as soon as the key is present, so a top-level null
    // hides the nested value rather than falling through to it.
    scriptModelAnswer('{"ticket_id": null, "data": {"ticket_id": "T-10"}}');
    const stateStore: SimulationStateStore = {};

    await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore).toEqual({});
  });

  it('searches past a nested null into the next branch', async () => {
    scriptModelAnswer('{"a": {"ticket_id": null}, "b": {"ticket_id": "T-10"}}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore).toEqual({ticket_id: {'T-10': result}});
  });

  it('replaces the entity when a later call returns the same id', async () => {
    scriptModelAnswer('{"ticket_id": "T-11", "status": "open"}');
    scriptModelAnswer('{"ticket_id": "T-11", "status": "cancelled"}');
    const stateStore: SimulationStateStore = {};

    await mock({stateStore, toolConnectionMap: connectionMap});
    await mock({stateStore, toolConnectionMap: connectionMap});

    expect(stateStore['ticket_id']['T-11']).toEqual({
      ticket_id: 'T-11',
      status: 'cancelled',
    });
  });
});

describe('ToolSpecMockStrategy prompt', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('shows the connection map with the keys the model was asked for', async () => {
    scriptModelAnswer('{"ok": true}');

    await mock({
      toolName: 'get_ticket',
      toolConnectionMap: {
        statefulParameters: [
          {
            parameterName: 'ticket_id',
            creatingTools: ['create_ticket'],
            consumingTools: ['get_ticket'],
          },
        ],
      },
    });

    const prompt = recordedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('"creating_tools"');
    expect(prompt).not.toContain('creatingTools');
  });

  it('stands in for an absent connection map', async () => {
    scriptModelAnswer('{"ok": true}');

    await mock({});

    const prompt = recordedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain(
      "Here is the map of how tools connect via stateful parameters:\n  ''",
    );
  });
});
