/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseRetrievalTool,
  Context,
  createSession,
  FeatureName,
  FunctionTool,
  InvocationContext,
  isBaseRetrievalTool,
  isBaseTool,
  LlmAgent,
  LlmRequest,
  PluginManager,
  RunAsyncToolRequest,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

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

/** The same declaration with `JSON_SCHEMA_FOR_FUNC_DECL` enabled. */
const EXPECTED_JSON_SCHEMA_DECLARATION = {
  name: 'test_retrieval',
  description: 'A test retrieval tool.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
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
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
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

describe('BaseRetrievalTool with JSON_SCHEMA_FOR_FUNC_DECL', () => {
  it('declares a genai Schema while the feature is disabled', async () => {
    const tool = new TestRetrievalTool();

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      false,
      () => tool._getDeclaration(),
    );

    expect(declaration.name).toBe('test_retrieval');
    expect(declaration.description).toBe('A test retrieval tool.');
    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(declaration.parameters?.properties).toHaveProperty('query');
  });

  it('declares a raw JSON schema while the feature is enabled', async () => {
    const tool = new TestRetrievalTool();

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => tool._getDeclaration(),
    );

    expect(declaration.parameters).toBeUndefined();
    expect(declaration).toEqual(EXPECTED_JSON_SCHEMA_DECLARATION);
  });

  it('leaves the query optional in the JSON schema shape too', async () => {
    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => new TestRetrievalTool()._getDeclaration(),
    );

    expect(declaration.parametersJsonSchema).not.toHaveProperty('required');
  });

  it('reads the feature on every call, not at construction', async () => {
    const tool = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      false,
      () => new TestRetrievalTool(),
    );

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => tool._getDeclaration(),
    );

    expect(declaration).toEqual(EXPECTED_JSON_SCHEMA_DECLARATION);
  });

  it('sends the feature-selected shape to the model', async () => {
    const tool = new TestRetrievalTool();
    const llmRequest = makeLlmRequest();

    await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () =>
        tool.processLlmRequest({llmRequest, toolContext: makeToolContext()}),
    );

    expect(llmRequest.config?.tools).toEqual([
      {functionDeclarations: [EXPECTED_JSON_SCHEMA_DECLARATION]},
    ]);
    expect(llmRequest.toolsDict['test_retrieval']).toBe(tool);
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
