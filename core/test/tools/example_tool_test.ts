/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  BaseAgent,
  BaseExampleProvider,
  Context,
  createSession,
  Example,
  ExampleTool,
  ExampleToolConfig,
  InputValidationError,
  InvocationContext,
  LlmRequest,
  PluginManager,
  ToolErrorType,
  ToolExecutionError,
} from '@google/adk';
import {Content} from '@google/genai';
import {FIXTURE_EXAMPLE, staticProvider} from './fixtures/example_providers.js';

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
 * Builds a `toolContext` stub exposing only the `userContent` used by
 * ExampleTool, cast to `Context` (mirrors `StubToolContext` in
 * `preload_memory_tool_test.ts`).
 */
function makeToolContext(userContent: unknown): Context {
  return {userContent} as unknown as Context;
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
    const toolContext = makeToolContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toBeDefined();
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });

  it('appends instructions from a BaseExampleProvider and threads the query', async () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);
    const getExamplesSpy = vi.spyOn(provider, 'getExamples');
    const tool = new ExampleTool(provider);
    const toolContext = makeToolContext({
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
    const toolContext = makeToolContext({
      role: 'user',
      parts: [{text: 'Search for cats'}],
    });
    const llmRequest = makeLlmRequest('gemini-1.5-pro');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toContain('```tool_code');
  });

  it('is a no-op when userContent is undefined', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext(undefined);
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when userContent has no parts', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext({role: 'user', parts: []});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when the first part has no text', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext({role: 'user', parts: [{}]});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('throws in runAsync because it is not meant to be called by the model', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext(undefined);

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'ExampleTool should not be called by model',
    );
  });

  it('is importable from @google/adk (public export)', () => {
    expect(new ExampleTool([])).toBeInstanceOf(ExampleTool);
  });
});

/**
 * Builds a real `Context` backed by a real `InvocationContext`/`Session` (no
 * stubs), so the tool is exercised against genuine ADK plumbing exactly as the
 * agent request loop invokes it (llm_agent.ts).
 */
function makeRealContext(userContent?: Content): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: {} as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
    userContent,
  });
  return new Context({invocationContext});
}

describe('ExampleTool (end-to-end with real framework objects)', () => {
  it('appends the few-shot block when driven through a real Context', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeRealContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });

  it('is a no-op when the real invocation has no user content', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeRealContext(undefined);
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});

/** Absolute path of the fixture module a config file names. */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/example_providers.ts', import.meta.url),
);

/** Absolute path of a config file sitting next to the fixture. */
const CONFIG_PATH = fileURLToPath(
  new URL('./fixtures/root_agent.yaml', import.meta.url),
);

/**
 * Builds a config carrying a value the declared type forbids. A config file is
 * parsed at run time, so its contents are not what the type promises.
 */
function malformedConfig(examples: unknown): ExampleToolConfig {
  return {examples} as ExampleToolConfig;
}

/** Runs the tool and returns the system instruction it appended. */
async function instructionFrom(
  tool: ExampleTool,
  query: string,
): Promise<string | undefined> {
  const llmRequest = makeLlmRequest('gemini-2.0-flash');
  await tool.processLlmRequest({
    toolContext: makeToolContext({role: 'user', parts: [{text: query}]}),
    llmRequest,
  });
  const instruction = llmRequest.config?.systemInstruction;
  return typeof instruction === 'string' ? instruction : undefined;
}

/** Message adk-python raises when the resolved value is not a provider. */
const NOT_A_PROVIDER_MESSAGE =
  'Example provider must be an instance of BaseExampleProvider.';

/** Message adk-python raises when `examples` is neither form. */
const BAD_EXAMPLES_MESSAGE =
  'Example tool config must be a list of examples or a fully-qualified name ' +
  'to a BaseExampleProvider object in code.';

describe('ExampleTool.fromConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a working tool from an inline list of examples', async () => {
    const tool = await ExampleTool.fromConfig(
      {examples: [SIMPLE_EXAMPLE]},
      CONFIG_PATH,
    );

    expect(await instructionFrom(tool, 'What is 2+2?')).toContain('4');
  });

  it('accepts an empty list of examples', async () => {
    const tool = await ExampleTool.fromConfig({examples: []}, CONFIG_PATH);

    expect(await instructionFrom(tool, 'What is 2+2?')).toContain('<EXAMPLES>');
  });

  it('resolves a named provider and threads the query to it', async () => {
    const getExamples = vi.spyOn(staticProvider, 'getExamples');

    const tool = await ExampleTool.fromConfig(
      {examples: `${FIXTURE_PATH}#staticProvider`},
      CONFIG_PATH,
    );
    const instruction = await instructionFrom(tool, 'Reset my password');

    expect(getExamples).toHaveBeenCalledWith('Reset my password');
    expect(instruction).toContain(FIXTURE_EXAMPLE.input.parts?.[0]?.text);
  });

  it('resolves a provider named relative to the config file', async () => {
    const tool = await ExampleTool.fromConfig(
      {examples: './example_providers.ts#staticProvider'},
      CONFIG_PATH,
    );

    expect(tool.examples).toBe(staticProvider);
  });

  it('rejects a name resolving to a value that is not a provider', async () => {
    const building = ExampleTool.fromConfig(
      {examples: `${FIXTURE_PATH}#notAProvider`},
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow(ToolExecutionError);
    await expect(building).rejects.toMatchObject({
      message: NOT_A_PROVIDER_MESSAGE,
      errorType: ToolErrorType.BAD_REQUEST,
    });
  });

  it('propagates the resolver error for a name that does not resolve', async () => {
    const building = ExampleTool.fromConfig(
      {examples: '/no/such/module.ts#provider'},
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow(InputValidationError);
    await expect(building).rejects.toMatchObject({
      message: 'Invalid fully qualified name: /no/such/module.ts#provider',
    });
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', {input: {}, output: []}],
    ['a list holding a malformed element', [{nope: 1}]],
    ['a list holding a non-object', ['not an example']],
    ['a list whose element has no output list', [{input: {}, output: 'no'}]],
    ['a list whose element has no input object', [{input: null, output: []}]],
  ])('rejects %s', async (_label, examples) => {
    const building = ExampleTool.fromConfig(
      malformedConfig(examples),
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow(ToolExecutionError);
    await expect(building).rejects.toMatchObject({
      message: BAD_EXAMPLES_MESSAGE,
      errorType: ToolErrorType.BAD_REQUEST,
    });
  });
});
