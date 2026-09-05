/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_tool_connection_analyzer.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports, and the three tests after them are adk-js own
 * tests.
 *
 * adk-python reads `caplog`; adk-js spies on `logger.warn`.
 */

import {ToolConnectionAnalyzer} from '@google/adk/tools/environment_simulation/tool_connection_analyzer.js';
import {logger} from '@google/adk/utils/logger.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  FakeTool,
  installFakeLlm,
  installFakeLlmResponses,
} from './simulation_test_utils.js';

function makeAnalyzer(...chunks: string[]) {
  const fakeLlm = installFakeLlm(...chunks);
  return {
    analyzer: new ToolConnectionAnalyzer('fake-model', {}),
    fakeLlm,
  };
}

describe('ToolConnectionAnalyzer.analyze', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_malformed_json_returns_empty_map_without_crashing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {analyzer} = makeAnalyzer('this is not json at all');

    const result = await analyzer.analyze([new FakeTool('create_ticket')]);

    expect(result).toEqual({statefulParameters: []});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse tool connection analysis'),
    );
  });

  it('test_valid_json_is_parsed_into_connection_map', async () => {
    const {analyzer} = makeAnalyzer(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools":' +
        ' ["get_ticket"]}]}',
    );

    const result = await analyzer.analyze([new FakeTool('create_ticket')]);

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

  it('test_fenced_json_is_stripped_before_parsing', async () => {
    const {analyzer} = makeAnalyzer(
      '```json\n' +
        '{"stateful_parameters": [{"parameter_name": "order_id",' +
        ' "creating_tools": ["create_order"], "consuming_tools":' +
        ' ["get_order"]}]}\n' +
        '```',
    );

    const result = await analyzer.analyze([new FakeTool('create_order')]);

    expect(result.statefulParameters).toHaveLength(1);
    expect(result.statefulParameters[0].parameterName).toBe('order_id');
  });

  it('propagates the error when the JSON has the wrong shape', async () => {
    const {analyzer} = makeAnalyzer('{"stateful_parameters": "not a list"}');

    await expect(
      analyzer.analyze([new FakeTool('create_ticket')]),
    ).rejects.toThrow();
  });

  it('sends the declaration of every declared tool, and nothing else', async () => {
    const {analyzer, fakeLlm} = makeAnalyzer('{"stateful_parameters": []}');

    await analyzer.analyze([
      new FakeTool('create_ticket'),
      new FakeTool('undeclared_tool', false),
    ]);

    expect(fakeLlm.lastPrompt).toContain('"name": "create_ticket"');
    expect(fakeLlm.lastPrompt).not.toContain('undeclared_tool');
  });

  it('ignores a streamed response that carries no part', async () => {
    installFakeLlmResponses(
      {},
      {content: {role: 'model', parts: []}},
      {
        content: {
          role: 'model',
          parts: [{text: '{"stateful_parameters": []}'}],
        },
      },
    );
    const analyzer = new ToolConnectionAnalyzer('fake-model', {});

    const result = await analyzer.analyze([new FakeTool('create_ticket')]);

    expect(result).toEqual({statefulParameters: []});
  });

  it('asks the model for JSON', async () => {
    const {analyzer, fakeLlm} = makeAnalyzer('{"stateful_parameters": []}');

    await analyzer.analyze([new FakeTool('create_ticket')]);

    expect(fakeLlm.requests[0].config?.responseMimeType).toBe(
      'application/json',
    );
    expect(fakeLlm.requests[0].model).toBe('fake-model');
  });
});
