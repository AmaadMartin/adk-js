/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  MockRequest,
  SequentialAgent,
  ToolConnectionMap,
  ToolSpecMockStrategy,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  StubTool,
  createToolContext,
  promptOf,
  stubRegistryWithText,
} from '../environment_simulation_test_utils.js';

const CREATE_TICKET_DECLARATION: FunctionDeclaration = {
  name: 'create_ticket',
  description: 'Creates a ticket.',
};
const CREATE_TICKET = new StubTool('create_ticket', CREATE_TICKET_DECLARATION);
const GET_TICKET = new StubTool('get_ticket', {
  name: 'get_ticket',
  description: 'Reads a ticket.',
});
const DECLARATIONLESS_TOOL = new StubTool('builtin_search');

const CONNECTION_MAP: ToolConnectionMap = {
  statefulParameters: [
    {
      parameterName: 'ticket_id',
      creatingTools: ['create_ticket'],
      consumingTools: ['get_ticket'],
    },
  ],
};

let toolContext: Context;

function request(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    tool: CREATE_TICKET,
    args: {title: 'Printer on fire'},
    toolContext,
    stateStore: {},
    ...overrides,
  };
}

describe('ToolSpecMockStrategy', () => {
  beforeEach(() => {
    toolContext = createToolContext(new SequentialAgent({name: 'root'}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a tool with no declaration without calling a model', async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    const response = await strategy.mock(request({tool: DECLARATIONLESS_TOOL}));

    expect(response).toEqual({
      status: 'error',
      error_message: 'Could not get tool declaration.',
    });
    expect(llm.requests).toEqual([]);
  });

  it('returns the parsed model response verbatim', async () => {
    stubRegistryWithText(['{"ticket_id": "T-1", "status": "open"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    const response = await strategy.mock(request());

    expect(response).toEqual({ticket_id: 'T-1', status: 'open'});
  });

  it('reports an unparseable model response with the raw output', async () => {
    stubRegistryWithText(['sorry, no JSON today']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    const response = await strategy.mock(request());

    expect(response).toEqual({
      status: 'error',
      error_message: 'Failed to generate valid JSON mock response.',
      llm_output: 'sorry, no JSON today',
    });
  });

  it('reports a JSON response that is not an object', async () => {
    stubRegistryWithText(['["T-1"]']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    const response = await strategy.mock(request());

    expect(response).toEqual({
      status: 'error',
      error_message: 'Failed to generate valid JSON mock response.',
      llm_output: '["T-1"]',
    });
  });

  it('stores a creating tool response and shows it to the next call', async () => {
    const llm = stubRegistryWithText(
      ['{"ticket_id": "T-1", "status": "open"}'],
      ['{"ticket_id": "T-1", "status": "open"}'],
    );
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(stateStore).toEqual({
      'ticket_id': {'T-1': {ticket_id: 'T-1', status: 'open'}},
    });

    // The consuming call carries no id in its arguments, so the entity can
    // only reach its prompt through the shared state store.
    await strategy.mock(
      request({
        tool: GET_TICKET,
        args: {query: 'latest'},
        stateStore,
        toolConnectionMap: CONNECTION_MAP,
      }),
    );

    expect(promptOf(llm, 1)).toContain(JSON.stringify(stateStore, null, 2));
  });

  it('finds the stateful id nested inside the response', async () => {
    stubRegistryWithText(['{"ticket": {"ticket_id": "T-2"}}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(stateStore).toEqual({
      'ticket_id': {'T-2': {ticket: {ticket_id: 'T-2'}}},
    });
  });

  it('finds the stateful id inside an array, skipping nullish entries', async () => {
    stubRegistryWithText([
      '{"results": [null, {"other": null}, {"ticket_id": "T-3"}]}',
    ]);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(Object.keys(stateStore['ticket_id'])).toEqual(['T-3']);
  });

  it('keeps searching past an array that holds no stateful id', async () => {
    stubRegistryWithText([
      '{"wrapper": {"items": [{"a": 1}], "ticket": {"ticket_id": "T-9"}}}',
    ]);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(Object.keys(stateStore['ticket_id'])).toEqual(['T-9']);
  });

  it('stores a non-string stateful id under its string form', async () => {
    stubRegistryWithText(['{"ticket_id": 42}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(stateStore).toEqual({'ticket_id': {'42': {ticket_id: 42}}});
  });

  it('leaves the state store untouched for a consuming tool', async () => {
    stubRegistryWithText(['{"ticket_id": "T-1", "status": "open"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({
        tool: GET_TICKET,
        stateStore,
        toolConnectionMap: CONNECTION_MAP,
      }),
    );

    expect(stateStore).toEqual({});
  });

  it('leaves the state store untouched when the id is absent', async () => {
    stubRegistryWithText(['{"status": "accepted"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(stateStore).toEqual({});
  });

  it('leaves the state store untouched when the id is null', async () => {
    stubRegistryWithText(['{"ticket_id": null}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(
      request({stateStore, toolConnectionMap: CONNECTION_MAP}),
    );

    expect(stateStore).toEqual({});
  });

  it('leaves the state store untouched without a connection map', async () => {
    stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});
    const stateStore: Record<string, Record<string, unknown>> = {};

    await strategy.mock(request({stateStore}));

    expect(stateStore).toEqual({});
  });

  it("renders an absent connection map as the literal ''", async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    await strategy.mock(request());

    expect(promptOf(llm)).toContain(
      "Here is the map of how tools connect via stateful parameters:\n  ''",
    );
  });

  it('renders the connection map as JSON when present', async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    await strategy.mock(request({toolConnectionMap: CONNECTION_MAP}));

    expect(promptOf(llm)).toContain(JSON.stringify(CONNECTION_MAP, null, 2));
  });

  it('includes the tool declaration, name, description and arguments', async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {});

    await strategy.mock(request());

    const prompt = promptOf(llm);
    expect(prompt).toContain('Tool Name: create_ticket');
    expect(prompt).toContain('Tool Description: create_ticket description');
    expect(prompt).toContain(
      JSON.stringify(CREATE_TICKET_DECLARATION, null, 2),
    );
    expect(prompt).toContain(
      JSON.stringify({title: 'Printer on fire'}, null, 2),
    );
  });

  it('includes the environment data snippet only when data is given', async () => {
    const withData = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    await new ToolSpecMockStrategy('test-model', {}).mock(
      request({environmentData: '{"tickets": []}'}),
    );
    expect(promptOf(withData)).toContain(
      '<environment_data>\n        {"tickets": []}\n        </environment_data>',
    );

    vi.restoreAllMocks();
    const without = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    await new ToolSpecMockStrategy('test-model', {}).mock(request());
    expect(promptOf(without)).not.toContain('<environment_data>');
  });

  it('includes the tracing snippet only when tracing is given', async () => {
    const withTracing = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    await new ToolSpecMockStrategy('test-model', {}).mock(
      request({tracing: '{"events": []}'}),
    );
    expect(promptOf(withTracing)).toContain(
      '<tracing>\n        {"events": []}\n        </tracing>',
    );

    vi.restoreAllMocks();
    const without = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    await new ToolSpecMockStrategy('test-model', {}).mock(request());
    expect(promptOf(without)).not.toContain('<tracing>');
  });

  it('sends the configured model and generation config', async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);
    const strategy = new ToolSpecMockStrategy('test-model', {
      temperature: 0.7,
    });

    await strategy.mock(request());

    expect(llm.requests[0].model).toBe('test-model');
    expect(llm.requests[0].config).toEqual({
      temperature: 0.7,
      responseMimeType: 'application/json',
    });
  });
});
