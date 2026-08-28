/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseRetrievalTool,
  Context,
  LlmRequest,
  RunAsyncToolRequest,
} from '@google/adk';
import {GenerateContentConfig, Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

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

function makeLlmRequest(): LlmRequestWithConfig {
  return {
    model: 'gemini-2.0-flash',
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

// The inherited `processLlmRequest` only reads `llmRequest`; the context is
// never touched, so an empty stand-in is enough.
function makeToolContext(): Context {
  return {} as Context;
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

    const declarations = (llmRequest.config.tools![0] as Tool)
      .functionDeclarations!;
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual(EXPECTED_DECLARATION);
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
