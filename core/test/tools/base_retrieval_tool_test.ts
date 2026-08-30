/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseRetrievalTool,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  isBaseRetrievalTool,
  isBaseTool,
  LlmAgent,
  LlmRequest,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeLlmRequest(): LlmRequest {
  return {
    model: 'gemini-2.0-flash',
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

function makeToolContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    // A real agent instance, so the fixture breaks if InvocationContext's
    // contract changes (rather than being silenced by a cast).
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

/** The declaration adk-python's `BaseRetrievalTool` produces, field for field. */
const EXPECTED_DECLARATION = {
  name: 'test_retrieval',
  description: 'A test retrieval tool.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The query to retrieve.',
      },
    },
  },
};

class TestRetrievalTool extends BaseRetrievalTool {
  constructor(name = 'test_retrieval', description = 'A test retrieval tool.') {
    super({name, description});
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    return {result: 'test', query: args['query']};
  }
}

describe('BaseRetrievalTool', () => {
  it('declares a single string query parameter', () => {
    const tool = new TestRetrievalTool();

    const declaration = tool._getDeclaration();

    expect(declaration).toEqual(EXPECTED_DECLARATION);
  });

  it('reads the name and the description from the subclass', () => {
    const tool = new TestRetrievalTool('other_retrieval', 'Another one.');

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('other_retrieval');
    expect(declaration.description).toBe('Another one.');
  });

  it('leaves the query parameter optional, as adk-python does', () => {
    const declaration = new TestRetrievalTool()._getDeclaration();

    expect(declaration.parameters?.required).toBeUndefined();
  });

  it('declares the schema through parameters, not parametersJsonSchema', () => {
    const declaration = new TestRetrievalTool()._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
  });

  it('adds the query declaration to the LLM request', async () => {
    const tool = new TestRetrievalTool();
    const llmRequest = makeLlmRequest();

    await tool.processLlmRequest({llmRequest, toolContext: makeToolContext()});

    expect(llmRequest.config?.tools).toEqual([
      {functionDeclarations: [EXPECTED_DECLARATION]},
    ]);
    expect(llmRequest.toolsDict['test_retrieval']).toBe(tool);
  });

  it('runs the subclass implementation with the model-supplied query', async () => {
    const tool = new TestRetrievalTool();

    const result = await tool.runAsync({
      args: {query: 'how do I ship it'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual({result: 'test', query: 'how do I ship it'});
  });

  it('rejects a duplicate tool name through the inherited request path', async () => {
    const tool = new TestRetrievalTool();
    const llmRequest = makeLlmRequest();
    const toolContext = makeToolContext();

    await tool.processLlmRequest({llmRequest, toolContext});

    await expect(
      tool.processLlmRequest({llmRequest, toolContext}),
    ).rejects.toThrow('Duplicate tool name: test_retrieval');
  });
});

describe('isBaseRetrievalTool', () => {
  it('recognises a retrieval tool', () => {
    expect(isBaseRetrievalTool(new TestRetrievalTool())).toBe(true);
  });

  it('keeps the tool a BaseTool, because the brand is additive', () => {
    expect(isBaseTool(new TestRetrievalTool())).toBe(true);
  });

  it('rejects a tool that does not retrieve', () => {
    const tool = new FunctionTool({
      name: 'plain_tool',
      description: 'A tool that retrieves nothing.',
      execute: async () => 'result',
    });

    expect(isBaseRetrievalTool(tool)).toBe(false);
  });

  it('recognises a tool branded by a second copy of the package', () => {
    // A `Symbol.for` brand lives in the global registry, so an instance built
    // by another copy of adk-js in the same runtime carries the same key.
    const fromOtherCopy = {
      [Symbol.for('google.adk.baseRetrievalTool')]: true,
    };

    expect(isBaseRetrievalTool(fromOtherCopy)).toBe(true);
  });

  it('rejects a value that carries the brand with the wrong value', () => {
    const impostor = {
      [Symbol.for('google.adk.baseRetrievalTool')]: 'yes',
    };

    expect(isBaseRetrievalTool(impostor)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'test_retrieval'],
    ['a number', 7],
    ['a plain object', {}],
  ])('rejects %s without throwing', (_name, value) => {
    expect(isBaseRetrievalTool(value)).toBe(false);
  });
});
