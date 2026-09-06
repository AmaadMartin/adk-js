/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python does not test: the guard that a parsed response really is a
 * JSON object, `null` as a not-found value in the recursive lookup, and what
 * the prompt carries. The ported reference tests live in
 * `tool_spec_mock_strategy_test.ts`.
 */

import {ToolConnectionMap} from '@google/adk';
import {ToolSpecMockStrategy} from '@google/adk/tools/environment_simulation/strategies/tool_spec_mock_strategy.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {FakeLlm, FakeTool, installFakeLlm} from '../simulation_test_utils.js';

const NOT_AN_OBJECT_MESSAGE = 'Generated mock response was not a JSON object.';

function makeStrategy(...chunks: string[]): {
  strategy: ToolSpecMockStrategy;
  fakeLlm: FakeLlm;
} {
  const fakeLlm = installFakeLlm(...chunks);
  return {strategy: new ToolSpecMockStrategy('fake-model', {}), fakeLlm};
}

function ticketMap(creatingTools: string[]): ToolConnectionMap {
  return {
    statefulParameters: [
      {parameterName: 'ticket_id', creatingTools, consumingTools: []},
    ],
  };
}

function mock(
  strategy: ToolSpecMockStrategy,
  options: {
    toolName?: string;
    stateStore?: Record<string, unknown>;
    toolConnectionMap?: ToolConnectionMap;
    args?: Record<string, unknown>;
    environmentData?: string;
    tracing?: string;
  } = {},
): Promise<Record<string, unknown>> {
  return strategy.mock({
    tool: new FakeTool(options.toolName ?? 'create_ticket'),
    args: options.args ?? {},
    toolConnectionMap: options.toolConnectionMap,
    stateStore: options.stateStore ?? {},
    environmentData: options.environmentData,
    tracing: options.tracing,
  });
}

describe('ToolSpecMockStrategy response guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['an array', '["not", "an", "object"]'],
    ['a null literal', 'null'],
    ['a number', '42'],
    ['a string', '"just text"'],
  ])('rejects %s as a mock response', async (_label, response) => {
    const {strategy} = makeStrategy(response);

    const result = await mock(strategy);

    expect(result).toEqual({
      status: 'error',
      error_message: NOT_AN_OBJECT_MESSAGE,
      llm_output: response,
    });
  });

  it('strips a fence that ends with a trailing newline', async () => {
    const {strategy} = makeStrategy('```json\n{"ticket_id": "T-1"}\n```\n');

    expect(await mock(strategy)).toEqual({ticket_id: 'T-1'});
  });
});

describe('ToolSpecMockStrategy state tracking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a null parameter value as not found', async () => {
    const {strategy} = makeStrategy('{"ticket_id": null}');
    const stateStore: Record<string, unknown> = {};

    await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({});
  });

  it('keeps searching past a null and finds the nested value', async () => {
    const {strategy} = makeStrategy(
      '{"ticket_id": null, "data": {"ticket_id": "T-9"}}',
    );
    const stateStore: Record<string, unknown> = {};

    const result = await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({ticket_id: {'T-9': result}});
  });

  it('writes nothing when an array holds no match', async () => {
    const {strategy} = makeStrategy('{"items": ["a", "b"]}');
    const stateStore: Record<string, unknown> = {};

    await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({});
  });

  it('finds a value inside an array', async () => {
    const {strategy} = makeStrategy('{"items": [{"ticket_id": "T-10"}]}');
    const stateStore: Record<string, unknown> = {};

    const result = await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({ticket_id: {'T-10': result}});
  });

  it('replaces a state entry that is not an object', async () => {
    const {strategy} = makeStrategy('{"ticket_id": "T-11"}');
    const stateStore: Record<string, unknown> = {ticket_id: 'not an object'};

    const result = await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({ticket_id: {'T-11': result}});
  });

  it('keys the entry by the string form of a numeric value', async () => {
    const {strategy} = makeStrategy('{"ticket_id": 12}');
    const stateStore: Record<string, unknown> = {};

    const result = await mock(strategy, {
      stateStore,
      toolConnectionMap: ticketMap(['create_ticket']),
    });

    expect(stateStore).toEqual({ticket_id: {'12': result}});
  });
});

describe('the ToolSpecMockStrategy prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits the environment data and tracing blocks when they are absent', async () => {
    const {strategy, fakeLlm} = makeStrategy('{"ok": true}');

    await mock(strategy);

    expect(fakeLlm.lastPrompt).not.toContain('<environment_data>');
    expect(fakeLlm.lastPrompt).not.toContain('<tracing>');
  });

  it('carries the environment data and tracing blocks when they are set', async () => {
    const {strategy, fakeLlm} = makeStrategy('{"ok": true}');

    await mock(strategy, {
      environmentData: 'a database dump',
      tracing: 'an earlier run',
    });

    expect(fakeLlm.lastPrompt).toContain('a database dump');
    expect(fakeLlm.lastPrompt).toContain('an earlier run');
  });

  it('shows the connection map in its snake_case wire form', async () => {
    const {strategy, fakeLlm} = makeStrategy('{"ok": true}');

    await mock(strategy, {toolConnectionMap: ticketMap(['create_ticket'])});

    expect(fakeLlm.lastPrompt).toContain('"parameter_name": "ticket_id"');
    expect(fakeLlm.lastPrompt).toContain('"creating_tools"');
    expect(fakeLlm.lastPrompt).not.toContain('parameterName');
  });

  it("shows '' when there is no connection map", async () => {
    const {strategy, fakeLlm} = makeStrategy('{"ok": true}');

    await mock(strategy);

    expect(fakeLlm.lastPrompt).toContain(
      "Here is the map of how tools connect via stateful parameters:\n  ''",
    );
  });

  it('does not expand a dollar pattern in an argument value', async () => {
    const {strategy, fakeLlm} = makeStrategy('{"ok": true}');

    await mock(strategy, {args: {note: "$& $' $1"}});

    expect(fakeLlm.lastPrompt).toContain('"note": "$& $\' $1"');
  });
});
