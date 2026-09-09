/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ToolConnectionAnalyzer} from '../../../src/tools/environment_simulation/tool_connection_analyzer.js';

import {
  capturedRequests,
  FakeTool,
  resetScriptedModel,
  SCRIPTED_MODEL,
  scriptReply,
} from './simulation_test_utils.js';

const CONNECTION_MAP_JSON =
  '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
  ' "creating_tools": ["create_ticket"], "consuming_tools": ["get_ticket"]}]}';

function createAnalyzer(): ToolConnectionAnalyzer {
  return new ToolConnectionAnalyzer(SCRIPTED_MODEL, {});
}

describe('ToolConnectionAnalyzer', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('parses a well-formed reply into a connection map', async () => {
    scriptReply(CONNECTION_MAP_JSON);

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result).toEqual({
      statefulParameters: [
        {
          parameterName: 'ticket_id',
          creatingTools: ['create_ticket'],
          consumingTools: ['get_ticket'],
        },
      ],
    });
  });

  it('unwraps a reply the model wrapped in a markdown fence', async () => {
    scriptReply('```json\n' + CONNECTION_MAP_JSON + '\n```');

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result.statefulParameters[0].parameterName).toBe('ticket_id');
  });

  it('joins a reply the model streamed in chunks', async () => {
    scriptReply(
      CONNECTION_MAP_JSON.slice(0, 20),
      CONNECTION_MAP_JSON.slice(20),
    );

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result.statefulParameters).toHaveLength(1);
  });

  it('skips a streamed response that carries no content', async () => {
    scriptReply(null, '', CONNECTION_MAP_JSON);

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result.statefulParameters).toHaveLength(1);
  });

  it('warns and yields an empty map when the reply is not JSON', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    scriptReply('this is not json at all');

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse tool connection analysis'),
    );
    warn.mockRestore();
  });

  it('yields an empty map when the reply is JSON of the wrong shape', async () => {
    scriptReply('{"parameters": []}');

    const result = await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
  });

  it('drops a parameter entry that has no name', async () => {
    scriptReply(
      '{"stateful_parameters": [{"creating_tools": ["a"]},' +
        ' {"parameter_name": "order_id"}]}',
    );

    const result = await createAnalyzer().analyze([
      new FakeTool('create_order'),
    ]);

    expect(result.statefulParameters).toEqual([
      {parameterName: 'order_id', creatingTools: [], consumingTools: []},
    ]);
  });

  it('drops a non-string tool name from a parameter entry', async () => {
    scriptReply(
      '{"stateful_parameters": [{"parameter_name": "order_id",' +
        ' "creating_tools": ["create_order", 7], "consuming_tools": "nope"}]}',
    );

    const result = await createAnalyzer().analyze([
      new FakeTool('create_order'),
    ]);

    expect(result.statefulParameters).toEqual([
      {
        parameterName: 'order_id',
        creatingTools: ['create_order'],
        consumingTools: [],
      },
    ]);
  });

  it('omits a tool that has no declaration from the prompt', async () => {
    scriptReply(CONNECTION_MAP_JSON);

    await createAnalyzer().analyze([
      new FakeTool('create_ticket'),
      new FakeTool('hidden_tool', {declared: false}),
    ]);

    const prompt = capturedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('create_ticket');
    expect(prompt).not.toContain('hidden_tool');
  });

  it('asks the model for JSON instead of free-form text', async () => {
    scriptReply(CONNECTION_MAP_JSON);

    await createAnalyzer().analyze([new FakeTool('create_ticket')]);

    expect(capturedRequests[0].config?.responseMimeType).toBe(
      'application/json',
    );
  });

  it('tells the model to answer with single braces', async () => {
    scriptReply(CONNECTION_MAP_JSON);

    await createAnalyzer().analyze([new FakeTool('create_ticket')]);

    const prompt = capturedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain("start with '{' and end with '}'");
  });
});
