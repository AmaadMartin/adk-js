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
  ToolArgsConfig,
} from '@google/adk';
import {
  FunctionDeclaration,
  FunctionResponseScheduling,
  Type,
} from '@google/genai';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const CONFIG_PATH = '/abs/path/to/agent.yaml';

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

class DeferringTool extends TestingTool {
  constructor(params: TestingToolParams) {
    super(params);
    this.defersResponse = true;
  }
}

/** A tool that builds itself from a config key `BaseTool` does not know. */
class GreetingTool extends BaseTool {
  constructor(
    params: BaseToolParams,
    readonly greeting: string,
  ) {
    super(params);
  }

  static override fromConfig(
    config: ToolArgsConfig,
    _configAbsPath: string,
  ): GreetingTool {
    return new GreetingTool(
      {name: String(config['name']), description: 'greets'},
      String(config['greeting']),
    );
  }

  async runAsync(): Promise<unknown> {
    return this.greeting;
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
  it('defaults defersResponse to false and lets a subclass set it', () => {
    const params = {name: 'test_tool', description: 'test_description'};

    expect(new TestingTool(params).defersResponse).toBe(false);
    expect(new DeferringTool(params).defersResponse).toBe(true);
  });

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

describe('BaseTool.fromConfig', () => {
  let warnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an instance carrying every recognized key', () => {
    const tool = TestingTool.fromConfig(
      {
        name: 'inventory',
        description: 'Looks up stock levels.',
        isLongRunning: true,
        customMetadata: {manifestVersion: 3},
        responseScheduling: FunctionResponseScheduling.WHEN_IDLE,
      },
      CONFIG_PATH,
    );

    expect(tool).toBeInstanceOf(TestingTool);
    expect(tool.name).toBe('inventory');
    expect(tool.description).toBe('Looks up stock levels.');
    expect(tool.isLongRunning).toBe(true);
    expect(tool.customMetadata).toEqual({manifestVersion: 3});
    expect(tool.responseScheduling).toBe(FunctionResponseScheduling.WHEN_IDLE);
  });

  it('leaves the optional fields unset when the config omits them', () => {
    const tool = TestingTool.fromConfig(
      {name: 'inventory', description: 'Looks up stock levels.'},
      CONFIG_PATH,
    );

    expect(tool.isLongRunning).toBe(false);
    expect(tool.customMetadata).toBeUndefined();
    expect(tool.responseScheduling).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing name', {description: 'd'}, "'name'"],
    ['a non-string name', {name: 7, description: 'd'}, "'name'"],
    ['an empty name', {name: '', description: 'd'}, "'name'"],
    ['a missing description', {name: 'n'}, "'description'"],
    ['a non-string description', {name: 'n', description: 7}, "'description'"],
    [
      'a non-boolean isLongRunning',
      {name: 'n', description: 'd', isLongRunning: 'yes'},
      "'isLongRunning'",
    ],
    [
      'null customMetadata',
      {name: 'n', description: 'd', customMetadata: null},
      "'customMetadata'",
    ],
    [
      'array customMetadata',
      {name: 'n', description: 'd', customMetadata: [1, 2]},
      "'customMetadata'",
    ],
    [
      'primitive customMetadata',
      {name: 'n', description: 'd', customMetadata: 'nope'},
      "'customMetadata'",
    ],
    [
      'an unknown responseScheduling',
      {name: 'n', description: 'd', responseScheduling: 'LOUD'},
      "'responseScheduling'",
    ],
    [
      'a non-string responseScheduling',
      {name: 'n', description: 'd', responseScheduling: 3},
      "'responseScheduling'",
    ],
  ])('rejects %s', (_label, config: ToolArgsConfig, key) => {
    expect(() => TestingTool.fromConfig(config, CONFIG_PATH)).toThrow(key);
    expect(() => TestingTool.fromConfig(config, CONFIG_PATH)).toThrow(
      CONFIG_PATH,
    );
  });

  it('warns about an unrecognized key and ignores it', () => {
    const tool = TestingTool.fromConfig(
      {name: 'inventory', description: 'Looks up stock levels.', region: 'eu'},
      CONFIG_PATH,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Unsupported parsing for argument: region.',
    );
    expect(Object.keys(tool)).not.toContain('region');
  });

  it('runs a subclass override and returns the subclass type', () => {
    const tool: GreetingTool = GreetingTool.fromConfig(
      {name: 'greeter', greeting: 'hello'},
      CONFIG_PATH,
    );

    expect(tool.greeting).toBe('hello');
    expect(tool.name).toBe('greeter');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
