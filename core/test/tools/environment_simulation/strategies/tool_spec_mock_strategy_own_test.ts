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

import {describe, expect, it} from 'vitest';

import {SimulationStateStore} from '../../../../src/tools/environment_simulation/strategies/base.js';
import {ToolSpecMockStrategy} from '../../../../src/tools/environment_simulation/strategies/tool_spec_mock_strategy.js';
import {ToolConnectionMap} from '../../../../src/tools/environment_simulation/tool_connection_map.js';

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

describe('ToolSpecMockStrategy fenced answers', () => {
  it('unwraps a fence whose answer ends with a newline', async () => {
    const strategy = createStrategy('```json\n{"ticketId": "T-12"}\n```\n');

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({ticketId: 'T-12'});
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

describe('ToolSpecMockStrategy hostile parameter names', () => {
  // A parameter name comes from the analyzer model's JSON, so it can be any
  // string. In JavaScript some strings reach the prototype chain instead of
  // the object, which would leak simulation state process-wide.

  it('records a parameter named __proto__ without touching Object.prototype', async () => {
    const strategy = createStrategy('{"__proto__": "P-1"}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('__proto__', 'create_ticket'),
      stateStore,
    });

    expect(Object.keys(stateStore)).toEqual(['__proto__']);
    expect(Object.hasOwn(stateStore, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(stateStore)).toBe(Object.prototype);
    const entities = Object.getOwnPropertyDescriptor(
      stateStore,
      '__proto__',
    )?.value;
    expect(entities).toEqual({'P-1': result});
    expect(Object.getOwnPropertyDescriptor({}, 'P-1')).toBeUndefined();
  });

  it('records a value named __proto__ without touching Object.prototype', async () => {
    const strategy = createStrategy('{"ticketId": "__proto__"}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('ticketId', 'create_ticket'),
      stateStore,
    });

    expect(Object.keys(stateStore['ticketId'])).toEqual(['__proto__']);
    expect(
      Object.getOwnPropertyDescriptor(stateStore['ticketId'], '__proto__')
        ?.value,
    ).toEqual(result);
    expect(Object.getOwnPropertyDescriptor({}, 'ticketId')).toBeUndefined();
  });

  it('does not find a parameter named constructor on every object', async () => {
    const strategy = createStrategy('{"ticketId": "T-13"}');
    const stateStore: SimulationStateStore = {};

    await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('constructor', 'create_ticket'),
      stateStore,
    });

    // The response declares no `constructor` of its own, so there is nothing
    // to key an entry by and the store stays empty. An unguarded search finds
    // the inherited `Object` constructor instead, and writes the response onto
    // `Object` itself, keyed by that function's own source text.
    expect(stateStore).toEqual({});
    expect(Object.hasOwn(stateStore, 'constructor')).toBe(false);
    expect(Object.hasOwn(Object, String(Object))).toBe(false);
  });

  it('records a parameter the response does declare as constructor', async () => {
    const strategy = createStrategy('{"constructor": "C-1"}');
    const stateStore: SimulationStateStore = {};

    const result = await strategy.mock({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(),
      toolConnectionMap: creatorMap('constructor', 'create_ticket'),
      stateStore,
    });

    expect(stateStore).toEqual({constructor: {'C-1': result}});
    expect(Object.getOwnPropertyDescriptor(Object, 'C-1')).toBeUndefined();
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
