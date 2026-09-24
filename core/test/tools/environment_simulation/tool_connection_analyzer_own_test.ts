/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ToolConnectionAnalyzer} from '../../../src/tools/environment_simulation/tool_connection_analyzer.js';
import {logger} from '../../../src/utils/logger.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  recordedRequests,
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

  it('leaves a tool with no declaration out of the prompt', async () => {
    scriptModelAnswer('{"stateful_parameters": []}');

    await createAnalyzer().analyze([
      new FakeTool({name: 'declared_tool'}),
      new FakeTool({name: 'undeclared_tool', declared: false}),
    ]);

    const prompt = recordedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('declared_tool');
    expect(prompt).not.toContain('undeclared_tool');
  });

  it('degrades to an empty map when the answer has the wrong shape', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    scriptModelAnswer('{"parameters": []}');

    const result = await createAnalyzer().analyze([
      new FakeTool({name: 'create_ticket'}),
    ]);

    expect(result).toEqual({statefulParameters: []});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse tool connection analysis'),
    );
    warn.mockRestore();
  });

  it('reads an answer the model split across chunks', async () => {
    scriptModelAnswer(
      '{"stateful_parameters": [{"parameter_name": "order_id",',
      ' "creating_tools": ["create_order"], "consuming_tools": []}]}',
    );

    const result = await createAnalyzer().analyze([
      new FakeTool({name: 'create_order'}),
    ]);

    expect(result.statefulParameters[0].parameterName).toBe('order_id');
  });

  it('asks the configured model with the configured configuration', async () => {
    const modelConfig = {temperature: 0.5};
    scriptModelAnswer('{"stateful_parameters": []}');

    await new ToolConnectionAnalyzer({
      model: FAKE_SIMULATION_MODEL,
      modelConfig,
    }).analyze([new FakeTool({name: 'create_ticket'})]);

    expect(recordedRequests[0].model).toBe(FAKE_SIMULATION_MODEL);
    expect(recordedRequests[0].config).toBe(modelConfig);
  });
});
