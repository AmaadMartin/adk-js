/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {FunctionDeclaration, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** A tool whose declaration is supplied by the test. */
class TestingTool extends BaseTool {
  constructor(private readonly declaration?: FunctionDeclaration) {
    super({name: 'test_tool', description: 'test_description'});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

/** A tool that produces its response through another orchestrator. */
class DeferringTool extends BaseTool {
  constructor() {
    super({name: 'deferring_tool', description: 'hands off the response'});
    this._defersResponse = true;
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

function createToolContext(): Context {
  const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
  const invocationContext = new InvocationContext({
    invocationId: 'invocation_id',
    agent,
    session: createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
    }),
    sessionService: new InMemorySessionService(),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

function createLlmRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

const TEST_DECLARATION: FunctionDeclaration = {
  name: 'test_tool',
  description: 'test_description',
  parameters: {type: Type.STRING, title: 'param_1'},
};

describe('BaseTool.processLlmRequest', () => {
  it('leaves the request alone when the tool has no declaration', async () => {
    const tool = new TestingTool();
    const llmRequest = createLlmRequest();

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config).toBeUndefined();
    expect(llmRequest.toolsDict).toStrictEqual({});
  });

  it('adds the declaration and registers the tool', async () => {
    const tool = new TestingTool(TEST_DECLARATION);
    const llmRequest = createLlmRequest();

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config!.tools![0]).toStrictEqual({
      functionDeclarations: [TEST_DECLARATION],
    });
    expect(llmRequest.toolsDict['test_tool']).toBe(tool);
  });

  it('adds a second tool entry next to a builtin tool', async () => {
    const tool = new TestingTool(TEST_DECLARATION);
    const llmRequest = createLlmRequest();
    llmRequest.config = {tools: [{googleSearch: {}}]};

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config.tools![1]).toStrictEqual({
      functionDeclarations: [TEST_DECLARATION],
    });
  });

  it('appends to the entry that already holds declarations', async () => {
    const tool = new TestingTool(TEST_DECLARATION);
    const llmRequest = createLlmRequest();
    llmRequest.config = {
      tools: [{googleSearch: {}}, {functionDeclarations: [{name: 'other'}]}],
    };

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config.tools![1]).toStrictEqual({
      functionDeclarations: [{name: 'other'}, TEST_DECLARATION],
    });
    expect(llmRequest.config.tools!.length).toBe(2);
  });

  it('rejects a name that is already registered', async () => {
    const tool = new TestingTool(TEST_DECLARATION);
    const llmRequest = createLlmRequest();
    llmRequest.toolsDict['test_tool'] = new TestingTool(TEST_DECLARATION);

    await expect(
      tool.processLlmRequest({
        toolContext: createToolContext(),
        llmRequest,
      }),
    ).rejects.toThrow('Duplicate tool name: test_tool');
  });
});

describe('BaseTool._defersResponse', () => {
  it('is false on a tool that does not set it', () => {
    expect(new TestingTool().isLongRunning).toBe(false);
    expect(new TestingTool()._defersResponse).toBe(false);
  });

  it('is true on a tool that sets it in its constructor', () => {
    expect(new DeferringTool()._defersResponse).toBe(true);
  });

  it('does not make the tool long-running', () => {
    expect(new DeferringTool().isLongRunning).toBe(false);
  });
});
