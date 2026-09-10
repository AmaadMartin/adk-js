/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_tool_connection_analyzer.py`
 * from google/adk-python (`main`, commit `c7ef8cfa`). Every `it` title is the
 * name of the reference test it ports. The own tests live in
 * `tool_connection_analyzer_own_test.ts`.
 *
 * The reference JSON names its keys `parameter_name`, `creating_tools` and
 * `consuming_tools`. adk-js asks the model for `parameterName`,
 * `creatingTools` and `consumingTools`, because the map never crosses a wire
 * and one naming beats a translation layer. The fixtures below use the adk-js
 * spelling for that reason.
 */

import {Logger, getLogger, setLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ToolConnectionAnalyzer} from '../../../src/tools/environment_simulation/tool_connection_analyzer.js';

import {
  FAKE_SIMULATION_MODEL,
  RecordingLogger,
  UncallableTool,
  scriptModel,
} from './simulation_test_support.js';

function createAnalyzer(): ToolConnectionAnalyzer {
  return new ToolConnectionAnalyzer({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  });
}

describe('ToolConnectionAnalyzer.analyze', () => {
  let previousLogger: Logger;
  let recordingLogger: RecordingLogger;

  beforeEach(() => {
    previousLogger = getLogger();
    recordingLogger = new RecordingLogger();
    setLogger(recordingLogger);
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('test_malformed_json_returns_empty_map_without_crashing', async () => {
    scriptModel('this is not json at all');

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
    expect(recordingLogger.warnings.join('\n')).toContain(
      'Failed to parse tool connection analysis',
    );
  });

  it('test_valid_json_is_parsed_into_connection_map', async () => {
    scriptModel(
      '{"statefulParameters": [{"parameterName": "ticket_id",' +
        ' "creatingTools": ["create_ticket"], "consumingTools":' +
        ' ["get_ticket"]}]}',
    );

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
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
    scriptModel(
      '```json\n' +
        '{"statefulParameters": [{"parameterName": "order_id",' +
        ' "creatingTools": ["create_order"], "consumingTools":' +
        ' ["get_order"]}]}\n' +
        '```',
    );

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_order'),
    ]);

    expect(result.statefulParameters).toHaveLength(1);
    expect(result.statefulParameters[0].parameterName).toBe('order_id');
  });
});
