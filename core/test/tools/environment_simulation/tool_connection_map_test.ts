/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the model half of
 * `tests/unittests/tools/environment_simulation/test_tool_connection_analyzer.py`
 * from google/adk-python (`main`). adk-python has no dedicated test file for
 * `tool_connection_map.py`, so the reference coverage of the model is indirect.
 *
 * Only one of that file's three tests is portable. The other two assert the
 * analyzer's Markdown-fence stripping and its JSON decode handler, both of
 * which live in `ToolConnectionAnalyzer.analyze` rather than the model, and
 * the analyzer is not ported. The `it` title is the reference test name.
 *
 * The own tests live in `tool_connection_map_own_test.ts`.
 */

import {parseToolConnectionMap} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ToolConnectionMap', () => {
  it('test_valid_json_is_parsed_into_connection_map', () => {
    const responseText =
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
      ' "creating_tools": ["create_ticket"], "consuming_tools":' +
      ' ["get_ticket"]}]}';

    const result = parseToolConnectionMap(JSON.parse(responseText));

    expect(result.statefulParameters).toHaveLength(1);
    const parameter = result.statefulParameters[0];
    expect(parameter.parameterName).toBe('ticket_id');
    expect(parameter.creatingTools).toEqual(['create_ticket']);
    expect(parameter.consumingTools).toEqual(['get_ticket']);
  });
});
