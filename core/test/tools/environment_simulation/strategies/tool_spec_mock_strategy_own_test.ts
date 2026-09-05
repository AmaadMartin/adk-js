/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `ToolSpecMockStrategy` behaviour that adk-python's suite does not
 * reach: a model answer that is valid JSON but not an object, the falsy
 * parameter values the recursive search must still treat as found, and the
 * prompt sections that carry the caller's environment data and trace.
 */

import {
  SimulationStateStore,
  ToolConnectionMap,
  ToolSpecMockStrategy,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  UncallableTool,
  capturedRequests,
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

function creatorMap(parameterName: string, tool: string): ToolConnectionMap {
  return {
    statefulParameters: [
      {parameterName, creatingTools: [tool], consumingTools: []},
    ],
  };
}

/** The text of the single prompt the fake model was sent. */
function onlyPromptText(): string {
  expect(capturedRequests).toHaveLength(1);
  return capturedRequests[0].contents[0].parts?.[0].text ?? '';
}

describe('ToolSpecMockStrategy model answers it cannot use', () => {
  it('reports a JSON array as not being an object', async () => {
    const strategy = createStrategy('[1, 2, 3]');

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Generated mock response was not a JSON object.',
      llmOutput: '[1, 2, 3]',
    });
  });

  it('reports a bare JSON number as not being an object', async () => {
    const strategy = createStrategy('42');

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Generated mock response was not a JSON object.',
      llmOutput: '42',
    });
  });

  it('reports a JSON null as not being an object', async () => {
    const strategy = createStrategy('null');

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      errorMessage: 'Generated mock response was not a JSON object.',
      llmOutput: 'null',
    });
  });
});

describe('ToolSpecMockStrategy state store writes', () => {
  it('records a parameter whose value is the number zero', async () => {
    const strategy = createStrategy('{"ticketId": 0, "status": "open"}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('ticketId', 'create_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({ticketId: {'0': result}});
  });

  it('records a parameter whose value is the empty string', async () => {
    const strategy = createStrategy('{"ticketId": ""}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('ticketId', 'create_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({ticketId: {'': result}});
  });

  it('records a parameter whose value is false', async () => {
    const strategy = createStrategy('{"archived": false}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('archive_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('archived', 'archive_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({archived: {'false': result}});
  });

  it('skips a parameter whose only value is null', async () => {
    const strategy = createStrategy('{"ticketId": null}');
    const stateStore: SimulationStateStore = {};

    await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('ticketId', 'create_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({});
  });

  it('finds a parameter nested inside an array', async () => {
    const strategy = createStrategy('{"items": [{"ticketId": "T-9"}]}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('ticketId', 'create_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({ticketId: {'T-9': result}});
  });

  it('records one response under every parameter the tool creates', async () => {
    const strategy = createStrategy('{"ticketId": "T-10", "userId": "U-1"}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: {
        statefulParameters: [
          {
            parameterName: 'ticketId',
            creatingTools: ['create_ticket'],
            consumingTools: [],
          },
          {
            parameterName: 'userId',
            creatingTools: ['create_ticket'],
            consumingTools: [],
          },
        ],
      },
      stateStore,
    });

    expect(stateStore).toEqual({
      ticketId: {'T-10': result},
      userId: {'U-1': result},
    });
  });
});

describe('ToolSpecMockStrategy prompt', () => {
  it('omits both optional sections when the caller supplies neither', async () => {
    const strategy = createStrategy('{"ok": true}');

    await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    const prompt = onlyPromptText();
    expect(prompt).not.toContain('<environment_data>');
    expect(prompt).not.toContain('<tracing>');
  });

  it("writes '' for the connection map when there is none", async () => {
    const strategy = createStrategy('{"ok": true}');

    await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(onlyPromptText()).toContain(
      "Here is the map of how tools connect via stateful parameters:\n  ''",
    );
  });

  it('carries the arguments and the state store into the prompt', async () => {
    const strategy = createStrategy('{"ok": true}');

    await strategy.mock({
      tool: new UncallableTool('get_ticket'),
      args: {ticketId: 'T-11'},
      context: createToolContext(),
      stateStore: {ticketId: {'T-11': {status: 'open'}}},
    });

    const prompt = onlyPromptText();
    expect(prompt).toContain('"ticketId": "T-11"');
    expect(prompt).toContain('"status": "open"');
    expect(prompt).toContain('Tool Name: get_ticket');
    expect(prompt).toContain('Tool Description: get_ticket description');
  });

  it('does not expand a dollar pattern in a substituted value', async () => {
    const strategy = createStrategy('{"ok": true}');

    await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {note: "$& $` $' $1"},
      context: createToolContext(),
      stateStore: {},
    });

    expect(onlyPromptText()).toContain('"note": "$& $` $\' $1"');
  });
});
