/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_tool_spec_mock_strategy.py`
 * from google/adk-python (`main`, commit `c7ef8cfa`). Every `it` title is the
 * name of the reference test it ports. The own tests live in
 * `tool_spec_mock_strategy_own_test.ts`.
 *
 * adk-python names the error keys `error_message` and `llm_output`. adk-js
 * spells every key it produces itself in camelCase, following the config
 * module, so the assertions below read `errorMessage` and `llmOutput`.
 */

import {describe, expect, it} from 'vitest';

import {SimulationStateStore} from '../../../../src/tools/environment_simulation/strategies/base.js';
import {ToolSpecMockStrategy} from '../../../../src/tools/environment_simulation/strategies/tool_spec_mock_strategy.js';
import {ToolConnectionMap} from '../../../../src/tools/environment_simulation/tool_connection_map.js';

import {
  FAKE_SIMULATION_MODEL,
  UncallableTool,
  createToolContext,
  scriptModel,
} from '../simulation_test_support.js';

function createStrategy(...responseChunks: string[]): ToolSpecMockStrategy {
  scriptModel(...responseChunks);
  return new ToolSpecMockStrategy({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  });
}

function connectionMap(
  parameterName: string,
  creatingTools: string[],
  consumingTools: string[],
): ToolConnectionMap {
  return {
    statefulParameters: [{parameterName, creatingTools, consumingTools}],
  };
}

function mock(params: {
  strategy: ToolSpecMockStrategy;
  tool: UncallableTool;
  stateStore: SimulationStateStore;
  toolConnectionMap?: ToolConnectionMap;
  args?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return params.strategy.mock({
    tool: params.tool,
    args: params.args ?? {},
    context: createToolContext(),
    toolConnectionMap: params.toolConnectionMap,
    stateStore: params.stateStore,
  });
}

describe('ToolSpecMockStrategy.mock', () => {
  it('test_tool_without_declaration_is_reported_as_an_error', async () => {
    const strategy = createStrategy('{"ok": true}');

    const result = await mock({
      strategy,
      tool: new UncallableTool('t', false),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Could not get tool declaration.',
    });
  });

  it('test_fenced_json_response_is_unwrapped', async () => {
    const strategy = createStrategy('```json\n{"ticket_id": "T-1"}\n```');

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('test_streamed_chunks_are_concatenated_before_parsing', async () => {
    const strategy = createStrategy('{"ticket', '_id": "T-2"}');

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-2'});
  });

  it('test_unparseable_response_is_returned_as_an_error_with_raw_output', async () => {
    const strategy = createStrategy('sorry, I cannot do that');

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Failed to generate valid JSON mock response.',
      llmOutput: 'sorry, I cannot do that',
    });
  });

  it('test_creating_tool_records_the_new_entity_in_the_state_store', async () => {
    const strategy = createStrategy('{"ticket_id": "T-3", "status": "open"}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
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
    const strategy = createStrategy('{"data": {"ticket_id": "T-4"}}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({ticket_id: {'T-4': result}});
  });

  it('test_consuming_tool_does_not_write_to_the_state_store', async () => {
    const strategy = createStrategy('{"ticket_id": "T-5"}');
    const stateStore: SimulationStateStore = {};

    await mock({
      strategy,
      tool: new UncallableTool('get_ticket'),
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
    const strategy = createStrategy('{"ticket_id": "T-7"}');
    const stateStore: SimulationStateStore = {
      ticket_id: {'T-6': {ticket_id: 'T-6'}},
    };

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore['ticket_id']['T-6']).toEqual({ticket_id: 'T-6'});
    expect(stateStore['ticket_id']['T-7']).toEqual(result);
  });

  it('test_missing_parameter_in_response_leaves_state_untouched', async () => {
    const strategy = createStrategy('{"status": "open"}');
    const stateStore: SimulationStateStore = {};

    await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({});
  });

  it('test_no_connection_map_means_no_state_tracking', async () => {
    const strategy = createStrategy('{"ticket_id": "T-8"}');
    const stateStore: SimulationStateStore = {};

    const result = await mock({
      strategy,
      tool: new UncallableTool('create_ticket'),
      stateStore,
    });

    expect(result).toEqual({ticket_id: 'T-8'});
    expect(stateStore).toEqual({});
  });
});
