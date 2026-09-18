/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `ToolConnectionAnalyzer` behaviour that adk-python's suite does not
 * reach: JSON that parses but has the wrong shape, and the tool schemas the
 * prompt carries.
 */

import {Logger, getLogger, setLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ToolConnectionAnalyzer} from '../../../src/tools/environment_simulation/tool_connection_analyzer.js';

import {
  CONTENTLESS_MODEL,
  FAKE_SIMULATION_MODEL,
  RecordingLogger,
  UncallableTool,
  capturedRequests,
  scriptModel,
} from './simulation_test_support.js';

function createAnalyzer(): ToolConnectionAnalyzer {
  return new ToolConnectionAnalyzer({
    model: FAKE_SIMULATION_MODEL,
    modelConfig: {},
  });
}

describe('ToolConnectionAnalyzer malformed answers', () => {
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

  it('degrades to an empty map when the JSON has the wrong shape', async () => {
    scriptModel('{"statefulParameters": "not a list"}');

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
    expect(recordingLogger.warnings.join('\n')).toContain(
      'Failed to parse tool connection analysis',
    );
  });

  it('degrades to an empty map when a parameter is missing a field', async () => {
    scriptModel('{"statefulParameters": [{"parameterName": "ticketId"}]}');

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
  });

  it('degrades to an empty map when the model answers with nothing', async () => {
    scriptModel();

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
  });

  it('degrades to an empty map when every response carries no content', async () => {
    const analyzer = new ToolConnectionAnalyzer({
      model: CONTENTLESS_MODEL,
      modelConfig: {},
    });

    const result = await analyzer.analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({statefulParameters: []});
  });

  it('drops a key the schema does not declare', async () => {
    scriptModel(
      '{"statefulParameters": [{"parameterName": "ticketId",' +
        ' "creatingTools": [], "consumingTools": [], "notes": "extra"}],' +
        ' "commentary": "hello"}',
    );

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result).toEqual({
      statefulParameters: [
        {parameterName: 'ticketId', creatingTools: [], consumingTools: []},
      ],
    });
  });
});

describe('ToolConnectionAnalyzer fenced answers', () => {
  it('reads a fence whose answer ends with a newline', async () => {
    scriptModel(
      '```json\n' +
        '{"statefulParameters": [{"parameterName": "ticketId",' +
        ' "creatingTools": ["create_ticket"], "consumingTools": []}]}\n' +
        '```\n',
    );

    const result = await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
    ]);

    expect(result.statefulParameters).toHaveLength(1);
    expect(result.statefulParameters[0].parameterName).toBe('ticketId');
  });
});

describe('ToolConnectionAnalyzer prompt', () => {
  it('carries the declaration of every declared tool', async () => {
    scriptModel('{"statefulParameters": []}');

    await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
      new UncallableTool('get_ticket'),
    ]);

    const prompt = capturedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('"name": "create_ticket"');
    expect(prompt).toContain('"name": "get_ticket"');
  });

  it('skips a tool that declares nothing', async () => {
    scriptModel('{"statefulParameters": []}');

    await createAnalyzer().analyze([
      new UncallableTool('create_ticket'),
      new UncallableTool('undeclared_tool', false),
    ]);

    const prompt = capturedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('"name": "create_ticket"');
    expect(prompt).not.toContain('undeclared_tool');
  });
});
