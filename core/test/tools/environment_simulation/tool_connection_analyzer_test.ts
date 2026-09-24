/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/environment_simulation/test_tool_connection_analyzer.py
// at google/adk-python@main.

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ToolConnectionAnalyzer} from '../../../src/tools/environment_simulation/tool_connection_analyzer.js';
import {logger} from '../../../src/utils/logger.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  resetFakeModel,
  scriptModelAnswer,
} from './simulation_test_support.js';

function createAnalyzer(): ToolConnectionAnalyzer {
  return new ToolConnectionAnalyzer({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  });
}

describe('ToolConnectionAnalyzer.analyze', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('test_malformed_json_returns_empty_map_without_crashing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    scriptModelAnswer('this is not json at all');

    const result = await createAnalyzer().analyze([
      new FakeTool({name: 'create_ticket'}),
    ]);

    expect(result.statefulParameters).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse tool connection analysis'),
    );
    warn.mockRestore();
  });

  it('test_valid_json_is_parsed_into_connection_map', async () => {
    scriptModelAnswer(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools":' +
        ' ["get_ticket"]}]}',
    );

    const result = await createAnalyzer().analyze([
      new FakeTool({name: 'create_ticket'}),
    ]);

    expect(result.statefulParameters).toEqual([
      {
        parameterName: 'ticket_id',
        creatingTools: ['create_ticket'],
        consumingTools: ['get_ticket'],
      },
    ]);
  });

  it('test_fenced_json_is_stripped_before_parsing', async () => {
    scriptModelAnswer(
      '```json\n' +
        '{"stateful_parameters": [{"parameter_name": "order_id",' +
        ' "creating_tools": ["create_order"], "consuming_tools":' +
        ' ["get_order"]}]}\n' +
        '```',
    );

    const result = await createAnalyzer().analyze([
      new FakeTool({name: 'create_order'}),
    ]);

    expect(result.statefulParameters).toHaveLength(1);
    expect(result.statefulParameters[0].parameterName).toBe('order_id');
  });
});
