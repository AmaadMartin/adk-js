/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {
  BaseExampleProvider,
  Context,
  createSession,
  Example,
  ExampleTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Content} from '@google/genai';

const SIMPLE_EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

const FUNCTION_CALL_EXAMPLE: Example = {
  input: {parts: [{text: 'Search for cats'}]},
  output: [
    {
      role: 'model',
      parts: [{functionCall: {name: 'search', args: {query: 'cats'}}}],
    },
    {role: 'model', parts: [{text: 'Found cats!'}]},
  ],
};

class FixedExampleProvider extends BaseExampleProvider {
  constructor(private readonly examples: Example[]) {
    super();
  }
  override getExamples(_query: string): Example[] {
    return this.examples;
  }
}

/**
 * Builds a `Context` backed by a real `InvocationContext`/`Session`/`LlmAgent`,
 * so the tool is exercised against genuine ADK plumbing rather than a cast stub.
 */
function makeContext(userContent?: Content): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
    userContent,
  });
  return new Context({invocationContext});
}

function makeLlmRequest(model?: string): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    config: {},
    model,
  };
}

describe('ExampleTool', () => {
  it('appends few-shot instructions from a static list of examples', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toContain('Begin few-shot');
    expect(instruction).toContain('End few-shot');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });

  it('appends instructions from a BaseExampleProvider and threads the query', async () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);
    const getExamplesSpy = vi.spyOn(provider, 'getExamples');
    const tool = new ExampleTool(provider);
    const toolContext = makeContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(getExamplesSpy).toHaveBeenCalledWith('What is 2+2?');
    expect(llmRequest.config?.systemInstruction).toContain('What is 2+2?');
  });

  it('forwards llmRequest.model to buildExampleSi (function-call fence style)', async () => {
    const tool = new ExampleTool([FUNCTION_CALL_EXAMPLE]);
    const toolContext = makeContext({
      role: 'user',
      parts: [{text: 'Search for cats'}],
    });
    const llmRequest = makeLlmRequest('gemini-1.5-pro');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toContain('```tool_code');
  });

  it('is a no-op when userContent is undefined', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeContext(undefined);
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when userContent has no parts', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeContext({role: 'user', parts: []});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when the first part has no text', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeContext({role: 'user', parts: [{}]});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('throws in runAsync because it is not meant to be called by the model', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeContext(undefined);

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'ExampleTool should not be called by model',
    );
  });
});
