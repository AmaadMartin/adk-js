/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/tools/environment_simulation/test_tool_spec_mock_strategy.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports. Own tests live in
 * `tool_spec_mock_strategy_own_test.ts`.
 */

import {BaseTool, ToolConnectionMap, ToolSpecMockStrategy} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  connectionMap,
  declaredTool,
  stubRegistryWithText,
  undeclaredTool,
} from './mock_strategy_test_utils.js';

function makeStrategy(...chunks: string[]): ToolSpecMockStrategy {
  stubRegistryWithText(chunks);
  return new ToolSpecMockStrategy('fake-model', {});
}

function mock(
  strategy: ToolSpecMockStrategy,
  tool: BaseTool,
  stateStore: Record<string, Record<string, unknown>>,
  toolConnectionMap?: ToolConnectionMap,
): Promise<Record<string, unknown>> {
  return strategy.mock({
    tool,
    args: {},
    toolConnectionMap,
    stateStore,
  });
}

describe('ToolSpecMockStrategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_tool_without_declaration_is_reported_as_an_error', async () => {
    const strategy = makeStrategy('{"ok": true}');

    const result = await mock(strategy, undeclaredTool('t'), {});

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Could not get tool declaration.',
    });
  });

  it('test_fenced_json_response_is_unwrapped', async () => {
    const strategy = makeStrategy('```json\n{"ticket_id": "T-1"}\n```');

    const result = await mock(strategy, declaredTool('create_ticket'), {});

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('test_streamed_chunks_are_concatenated_before_parsing', async () => {
    const strategy = makeStrategy('{"ticket', '_id": "T-2"}');

    const result = await mock(strategy, declaredTool('create_ticket'), {});

    expect(result).toEqual({ticket_id: 'T-2'});
  });

  it('test_unparseable_response_is_returned_as_an_error_with_raw_output', async () => {
    const strategy = makeStrategy('sorry, I cannot do that');

    const result = await mock(strategy, declaredTool('create_ticket'), {});

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Failed to generate valid JSON mock response.',
      llmOutput: 'sorry, I cannot do that',
    });
  });

  it('test_creating_tool_records_the_new_entity_in_the_state_store', async () => {
    const strategy = makeStrategy('{"ticket_id": "T-3", "status": "open"}');
    const stateStore = {};

    const result = await mock(
      strategy,
      declaredTool('create_ticket'),
      stateStore,
      connectionMap({
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: ['get_ticket'],
      }),
    );

    expect(stateStore).toEqual({ticket_id: {'T-3': result}});
  });

  it('test_state_store_entry_is_keyed_by_a_nested_parameter_value', async () => {
    const strategy = makeStrategy('{"data": {"ticket_id": "T-4"}}');
    const stateStore = {};

    const result = await mock(
      strategy,
      declaredTool('create_ticket'),
      stateStore,
      connectionMap({
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: [],
      }),
    );

    expect(stateStore).toEqual({ticket_id: {'T-4': result}});
  });

  it('test_consuming_tool_does_not_write_to_the_state_store', async () => {
    const strategy = makeStrategy('{"ticket_id": "T-5"}');
    const stateStore = {};

    await mock(
      strategy,
      declaredTool('get_ticket'),
      stateStore,
      connectionMap({
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: ['get_ticket'],
      }),
    );

    expect(stateStore).toEqual({});
  });

  it('test_existing_state_entries_are_kept_when_a_new_one_is_added', async () => {
    const strategy = makeStrategy('{"ticket_id": "T-7"}');
    const stateStore: Record<string, Record<string, unknown>> = {
      ticket_id: {'T-6': {ticket_id: 'T-6'}},
    };

    const result = await mock(
      strategy,
      declaredTool('create_ticket'),
      stateStore,
      connectionMap({
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: [],
      }),
    );

    expect(stateStore['ticket_id']['T-6']).toEqual({ticket_id: 'T-6'});
    expect(stateStore['ticket_id']['T-7']).toBe(result);
  });

  it('test_missing_parameter_in_response_leaves_state_untouched', async () => {
    const strategy = makeStrategy('{"status": "open"}');
    const stateStore = {};

    await mock(
      strategy,
      declaredTool('create_ticket'),
      stateStore,
      connectionMap({
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: [],
      }),
    );

    expect(stateStore).toEqual({});
  });

  it('test_no_connection_map_means_no_state_tracking', async () => {
    const strategy = makeStrategy('{"ticket_id": "T-8"}');
    const stateStore = {};

    const result = await mock(
      strategy,
      declaredTool('create_ticket'),
      stateStore,
    );

    expect(result).toEqual({ticket_id: 'T-8'});
    expect(stateStore).toEqual({});
  });
});
