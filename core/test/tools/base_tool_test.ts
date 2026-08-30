/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolParams,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {
  FunctionDeclaration,
  FunctionResponseScheduling,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const DECLARATION: FunctionDeclaration = {
  name: 'test_tool',
  description: 'test_description',
  parameters: {type: Type.STRING, title: 'param_1'},
};

interface TestingToolParams extends BaseToolParams {
  declaration?: FunctionDeclaration;
}

class TestingTool extends BaseTool {
  private readonly declaration?: FunctionDeclaration;

  constructor(params: TestingToolParams) {
    super(params);
    this.declaration = params.declaration;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(): Promise<unknown> {
    return undefined;
  }
}

function createTestingTool(declaration?: FunctionDeclaration): TestingTool {
  return new TestingTool({
    name: 'test_tool',
    description: 'test_description',
    declaration,
  });
}

function createToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'invocation_id',
    agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
    session: createSession({id: 'session_id', appName: 'test_app'}),
    pluginManager: new PluginManager(),
  });
  return new Context({invocationContext});
}

function createLlmRequest(config?: LlmRequest['config']): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, config};
}

/** The declarations of the `index`-th tool entry on the request. */
function declarationsAt(
  llmRequest: LlmRequest,
  index: number,
): FunctionDeclaration[] | undefined {
  const tool = llmRequest.config?.tools?.[index];
  if (tool && 'functionDeclarations' in tool) {
    return tool.functionDeclarations;
  }
  return undefined;
}

describe('BaseTool.processLlmRequest', () => {
  let toolContext: Context;

  beforeEach(() => {
    toolContext = createToolContext();
  });

  it('adds no tools when the tool has no declaration', async () => {
    const llmRequest = createLlmRequest();

    await createTestingTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.tools).toBeUndefined();
  });

  it('adds the declaration to the request config', async () => {
    const llmRequest = createLlmRequest();

    await createTestingTool(DECLARATION).processLlmRequest({
      toolContext,
      llmRequest,
    });

    expect(declarationsAt(llmRequest, 0)).toEqual([DECLARATION]);
  });

  it('puts the declaration in a new entry beside a builtin tool', async () => {
    const llmRequest = createLlmRequest({tools: [{googleSearch: {}}]});

    await createTestingTool(DECLARATION).processLlmRequest({
      toolContext,
      llmRequest,
    });

    expect(declarationsAt(llmRequest, 1)).toEqual([DECLARATION]);
  });

  it('appends the declaration to an entry that already declares functions', async () => {
    const llmRequest = createLlmRequest({
      tools: [{googleSearch: {}}, {functionDeclarations: [{name: 'other'}]}],
    });

    await createTestingTool(DECLARATION).processLlmRequest({
      toolContext,
      llmRequest,
    });

    expect(declarationsAt(llmRequest, 1)).toEqual([
      {name: 'other'},
      DECLARATION,
    ]);
  });

  it('rejects a name already registered on the request', async () => {
    const llmRequest = createLlmRequest();
    await createTestingTool(DECLARATION).processLlmRequest({
      toolContext,
      llmRequest,
    });

    await expect(
      createTestingTool(DECLARATION).processLlmRequest({
        toolContext,
        llmRequest,
      }),
    ).rejects.toThrow('Duplicate tool name: test_tool');
  });
});

describe('BaseTool fields', () => {
  it('defaults responseScheduling and customMetadata to undefined', () => {
    const tool = createTestingTool();

    expect(tool.responseScheduling).toBeUndefined();
    expect(tool.customMetadata).toBeUndefined();
  });

  it('carries responseScheduling and customMetadata from the constructor', () => {
    const tool = new TestingTool({
      name: 'test_tool',
      description: 'test_description',
      responseScheduling: FunctionResponseScheduling.SILENT,
      customMetadata: {manifestVersion: 3, owner: 'catalog'},
    });

    expect(tool.responseScheduling).toBe(FunctionResponseScheduling.SILENT);
    expect(tool.customMetadata).toEqual({manifestVersion: 3, owner: 'catalog'});
  });

  it('accepts customMetadata assigned after construction', () => {
    const tool = createTestingTool();

    tool.customMetadata = {owner: 'catalog'};

    expect(tool.customMetadata).toEqual({owner: 'catalog'});
  });
});
