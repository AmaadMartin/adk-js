/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it} from 'vitest';

import {ToolConnectionMap} from '../../../src/tools/environment_simulation/tool_connection_map.js';
import {
  StateStore,
  ToolSpecMockStrategy,
} from '../../../src/tools/environment_simulation/tool_spec_mock_strategy.js';

import {
  capturedRequests,
  createToolContext,
  FakeTool,
  resetScriptedModel,
  SCRIPTED_MODEL,
  scriptReply,
} from './simulation_test_utils.js';

function connectionMap(
  parameterName: string,
  creatingTools: string[],
  consumingTools: string[],
): ToolConnectionMap {
  return {
    statefulParameters: [{parameterName, creatingTools, consumingTools}],
  };
}

async function mock(options: {
  tool: FakeTool;
  stateStore: StateStore;
  toolConnectionMap?: ToolConnectionMap;
  environmentData?: string;
  tracing?: string;
}): Promise<Record<string, unknown>> {
  const strategy = new ToolSpecMockStrategy(SCRIPTED_MODEL, {});
  return strategy.mock({
    tool: options.tool,
    args: {},
    toolContext: createToolContext(),
    toolConnectionMap: options.toolConnectionMap,
    stateStore: options.stateStore,
    environmentData: options.environmentData,
    tracing: options.tracing,
  });
}

function lastPrompt(): string {
  const request = capturedRequests[capturedRequests.length - 1];
  return request.contents[0].parts?.[0].text ?? '';
}

describe('ToolSpecMockStrategy', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('reports an error when the tool has no declaration to mock against', async () => {
    scriptReply('{"ok": true}');

    const result = await mock({
      tool: new FakeTool('t', {declared: false}),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Could not get tool declaration.',
    });
    expect(capturedRequests).toHaveLength(0);
  });

  it('unwraps a reply the model wrapped in a markdown fence', async () => {
    scriptReply('```json\n{"ticket_id": "T-1"}\n```');

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('joins a reply the model streamed in chunks', async () => {
    scriptReply('{"ticket', '_id": "T-2"}');

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({ticket_id: 'T-2'});
  });

  it('reports an error with the raw text when the reply is not JSON', async () => {
    scriptReply('sorry, I cannot do that');

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Failed to generate valid JSON mock response.',
      llm_output: 'sorry, I cannot do that',
    });
  });

  it('reports an error with the raw text when the reply is not a JSON object', async () => {
    scriptReply('[1, 2]');

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Generated mock response was not a JSON object.',
      llm_output: '[1, 2]',
    });
  });

  it('records the entity a creating tool minted', async () => {
    scriptReply('{"ticket_id": "T-3", "status": "open"}');
    const stateStore: StateStore = {};

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap(
        'ticket_id',
        ['create_ticket'],
        ['get_ticket'],
      ),
    });

    expect(stateStore).toEqual({ticket_id: {'T-3': result}});
  });

  it('finds the minted identifier nested inside the reply', async () => {
    scriptReply('{"data": {"tickets": [{"ticket_id": "T-4"}]}}');
    const stateStore: StateStore = {};

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({ticket_id: {'T-4': result}});
  });

  it('keeps the entities recorded by an earlier call', async () => {
    scriptReply('{"ticket_id": "T-7"}');
    const stateStore: StateStore = {ticket_id: {'T-6': {ticket_id: 'T-6'}}};

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore['ticket_id']['T-6']).toEqual({ticket_id: 'T-6'});
    expect(stateStore['ticket_id']['T-7']).toEqual(result);
  });

  it('records nothing for a consuming tool', async () => {
    scriptReply('{"ticket_id": "T-5"}');
    const stateStore: StateStore = {};

    await mock({
      tool: new FakeTool('get_ticket'),
      stateStore,
      toolConnectionMap: connectionMap(
        'ticket_id',
        ['create_ticket'],
        ['get_ticket'],
      ),
    });

    expect(stateStore).toEqual({});
  });

  it('records nothing when the reply omits the stateful parameter', async () => {
    scriptReply('{"status": "open"}');
    const stateStore: StateStore = {};

    await mock({
      tool: new FakeTool('create_ticket'),
      stateStore,
      toolConnectionMap: connectionMap('ticket_id', ['create_ticket'], []),
    });

    expect(stateStore).toEqual({});
  });

  it('records nothing when there is no connection map', async () => {
    scriptReply('{"ticket_id": "T-8"}');
    const stateStore: StateStore = {};

    const result = await mock({
      tool: new FakeTool('create_ticket'),
      stateStore,
    });

    expect(result).toEqual({ticket_id: 'T-8'});
    expect(stateStore).toEqual({});
  });

  it('shows the connection map to the model under its snake_case keys', async () => {
    scriptReply('{"ticket_id": "T-9"}');

    await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
      toolConnectionMap: connectionMap(
        'ticket_id',
        ['create_ticket'],
        ['get_ticket'],
      ),
    });

    expect(lastPrompt()).toContain('"parameter_name": "ticket_id"');
  });

  it('omits the environment data and tracing blocks when they are unset', async () => {
    scriptReply('{"ok": true}');

    await mock({tool: new FakeTool('create_ticket'), stateStore: {}});

    expect(lastPrompt()).not.toContain('<environment_data>');
    expect(lastPrompt()).not.toContain('<tracing>');
  });

  it('includes the environment data and tracing blocks when they are set', async () => {
    scriptReply('{"ok": true}');

    await mock({
      tool: new FakeTool('create_ticket'),
      stateStore: {},
      environmentData: '{"tickets": []}',
      tracing: '{"calls": []}',
    });

    expect(lastPrompt()).toContain(
      '<environment_data>\n        {"tickets": []}',
    );
    expect(lastPrompt()).toContain('<tracing>\n        {"calls": []}');
  });

  it('tells the model to answer with single braces', async () => {
    scriptReply('{"ok": true}');

    await mock({tool: new FakeTool('create_ticket'), stateStore: {}});

    expect(lastPrompt()).toContain("start with '{' and end with '}'");
  });

  it('asks the model for JSON instead of free-form text', async () => {
    scriptReply('{"ok": true}');

    await mock({tool: new FakeTool('create_ticket'), stateStore: {}});

    expect(capturedRequests[0].config?.responseMimeType).toBe(
      'application/json',
    );
  });
});
