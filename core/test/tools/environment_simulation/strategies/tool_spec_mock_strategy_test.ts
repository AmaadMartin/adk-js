/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/environment_simulation/test_tool_spec_mock_strategy.py
// at google/adk-python@main.

import {beforeEach, describe, expect, it} from 'vitest';

import {SimulationStateStore} from '../../../../src/tools/environment_simulation/strategies/base.js';
import {ToolSpecMockStrategy} from '../../../../src/tools/environment_simulation/strategies/tool_spec_mock_strategy.js';
import {ToolConnectionMap} from '../../../../src/tools/environment_simulation/tool_connection_map.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
  resetFakeModel,
  scriptModelAnswer,
} from '../simulation_test_support.js';

function createStrategy(): ToolSpecMockStrategy {
  return new ToolSpecMockStrategy({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  });
}

function connectionMap(
  parameterName: string,
  creating: string[],
  consuming: string[],
): ToolConnectionMap {
  return {
    statefulParameters: [
      {parameterName, creatingTools: creating, consumingTools: consuming},
    ],
  };
}

function mock(params: {
  tool: FakeTool;
  stateStore: SimulationStateStore;
  toolConnectionMap?: ToolConnectionMap;
  args?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return createStrategy().mock({
    tool: params.tool,
    args: params.args ?? {},
    toolContext: createToolContext(),
    toolConnectionMap: params.toolConnectionMap,
    stateStore: params.stateStore,
  });
}

describe('ToolSpecMockStrategy.mock', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('test_tool_without_declaration_is_reported_as_an_error', async () => {
    scriptModelAnswer('{"ok": true}');

    const result = await mock({
      tool: new FakeTool({name: 't', declared: false}),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Could not get tool declaration.',
    });
  });

  it('test_fenced_json_response_is_unwrapped', async () => {
    scriptModelAnswer('```json\n{"ticket_id": "T-1"}\n```');

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('test_streamed_chunks_are_concatenated_before_parsing', async () => {
    scriptModelAnswer('{"ticket', '_id": "T-2"}');

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-2'});
  });

  it('test_unparseable_response_is_returned_as_an_error_with_raw_output', async () => {
    scriptModelAnswer('sorry, I cannot do that');

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Failed to generate valid JSON mock response.',
      llm_output: 'sorry, I cannot do that',
    });
  });

  it('test_creating_tool_records_the_new_entity_in_the_state_store', async () => {
    scriptModelAnswer('{"ticket_id": "T-3", "status": "open"}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore,
      toolConnectionMap: connectionMap(
        'ticket_id',
        ['create_ticket'],
        ['get_ticket'],
      ),
    });

    expect(stateStore).toEqual({ticket_id: {'T-3': result}});
  });

  it('test_state_store_entry_is_keyed_by_a_nested_parameter_value', async () => {
    scriptModelAnswer('{"data": {"ticket_id": "T-4"}}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({ticket_id: {'T-4': result}});
  });

  it('test_consuming_tool_does_not_write_to_the_state_store', async () => {
    scriptModelAnswer('{"ticket_id": "T-5"}');
    const stateStore: SimulationStateStore = {};

    await mock({
      tool: new FakeTool({name: 'get_ticket'}),
      stateStore,
      toolConnectionMap: connectionMap(
        'ticket_id',
        ['create_ticket'],
        ['get_ticket'],
      ),
    });

    expect(stateStore).toEqual({});
  });

  it('test_existing_state_entries_are_kept_when_a_new_one_is_added', async () => {
    scriptModelAnswer('{"ticket_id": "T-7"}');
    const stateStore: SimulationStateStore = {
      ticket_id: {'T-6': {ticket_id: 'T-6'}},
    };

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore['ticket_id']['T-6']).toEqual({ticket_id: 'T-6'});
    expect(stateStore['ticket_id']['T-7']).toBe(result);
  });

  it('test_missing_parameter_in_response_leaves_state_untouched', async () => {
    scriptModelAnswer('{"status": "open"}');
    const stateStore: SimulationStateStore = {};

    await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({});
  });

  it('test_no_connection_map_means_no_state_tracking', async () => {
    scriptModelAnswer('{"ticket_id": "T-8"}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      tool: new FakeTool({name: 'create_ticket'}),
      stateStore,
    });

    expect(result).toEqual({ticket_id: 'T-8'});
    expect(stateStore).toEqual({});
  });
});
