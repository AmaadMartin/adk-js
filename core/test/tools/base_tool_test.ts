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
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  RunAsyncToolRequest,
  ToolArgsConfig,
  ToolErrorType,
  ToolExecutionError,
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

/** A tool that does not classify its own responses. */
class PlainTool extends BaseTool {
  constructor() {
    super({name: 'plain', description: 'Does one thing.'});
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return req.args;
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

describe('BaseTool.detectErrorInResponse', () => {
  it('is implemented by a tool that classifies its own responses', () => {
    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echoes.',
      execute: () => 'ok',
    });

    expect(typeof tool.detectErrorInResponse).toBe('function');
  });

  it('is absent on a tool that does not declare it', () => {
    expect(new PlainTool().detectErrorInResponse).toBeUndefined();
  });
});

class SimpleTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

interface LabelledToolParams extends BaseToolParams {
  label: string;
}

class LabelledTool extends BaseTool {
  readonly label: string;

  constructor(params: LabelledToolParams) {
    super(params);
    this.label = params.label;
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

/** A second plain tool, so `fromConfig` can be pinned to its receiver. */
class OtherSimpleTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

/** A tool whose matching `FunctionResponse` is supplied by something else. */
class DeferringTool extends BaseTool {
  override defersResponse = true;

  override async runAsync(): Promise<unknown> {
    return null;
  }
}

interface ConfigPathToolConfig {
  name: string;
}

/** A tool whose own config seam reads the config file path. */
class ConfigPathTool extends BaseTool {
  static override async fromConfig(
    config: ConfigPathToolConfig,
    configAbsPath: string,
  ): Promise<ConfigPathTool> {
    return new ConfigPathTool({
      name: config.name,
      description: `loaded from ${configAbsPath}`,
    });
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

interface NarrowToolConfig {
  target: string;
}

/**
 * Narrows `fromConfig` to its own config interface, the way the tools ported
 * from adk-python do. The compile check is the point: if `ToolArgsConfig` ever
 * regresses to an index-signature type, this override stops type checking with
 * TS2417 here rather than in an unrelated package.
 */
class NarrowTool extends BaseTool {
  readonly target: string;

  constructor(params: BaseToolParams & {target: string}) {
    super(params);
    this.target = params.target;
  }

  static override async fromConfig(
    config: NarrowToolConfig,
    _configAbsPath?: string,
  ): Promise<NarrowTool> {
    return new NarrowTool({
      name: 'narrow',
      description: 'a tool that reads its own config shape',
      target: config.target,
    });
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

/**
 * A config loader hands over whatever the file parsed to, untyped. Routing the
 * rejection fixtures through this models that, and keeps the runtime guards
 * reachable from a test without weakening the declared parameter type.
 */
function parseToolConfig(json: string): ToolArgsConfig {
  return JSON.parse(json) as ToolArgsConfig;
}

/** Runs `fromConfig` and returns the `ToolExecutionError` it rejected with. */
async function rejectionOf(
  config: ToolArgsConfig,
): Promise<ToolExecutionError> {
  try {
    await SimpleTool.fromConfig(config);
  } catch (e: unknown) {
    if (e instanceof ToolExecutionError) {
      return e;
    }
    expect.fail(`expected a ToolExecutionError, got ${String(e)}`);
  }
  expect.fail('expected fromConfig to reject');
}

/**
 * Asserts the rejection, and pins which check produced it. Asserting only the
 * error type would let any guard stand in for any other.
 */
async function expectBadConfig(
  config: ToolArgsConfig,
  requirement: string,
): Promise<void> {
  const error = await rejectionOf(config);

  expect(error.message).toContain(requirement);

  expect(error.errorType).toBe(ToolErrorType.BAD_REQUEST);
}

describe('BaseTool.customMetadata', () => {
  it('is undefined when the constructor params omit it', () => {
    const tool = new SimpleTool({name: 'plain_tool', description: 'A tool.'});

    expect(tool.customMetadata).toBeUndefined();
  });

  it('is the metadata passed through BaseToolParams', () => {
    const tool = new SimpleTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v', nested: {a: 1}},
    });

    expect(tool.customMetadata).toEqual({
      'my.vendor.key': 'v',
      nested: {a: 1},
    });
  });

  it('can be assigned after construction', () => {
    const tool = new SimpleTool({name: 'plain_tool', description: 'A tool.'});

    tool.customMetadata = {'my.vendor.key': 'v'};

    expect(tool.customMetadata).toEqual({'my.vendor.key': 'v'});
  });

  it('keeps existing keys when a key is added after construction', () => {
    const tool = new SimpleTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v'},
    });

    tool.customMetadata = {...tool.customMetadata, 'my.vendor.id': 'abc-123'};

    expect(tool.customMetadata).toEqual({
      'my.vendor.key': 'v',
      'my.vendor.id': 'abc-123',
    });
  });

  it('leaves isLongRunning at its default when only metadata is supplied', () => {
    const tool = new SimpleTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v'},
    });

    expect(tool.isLongRunning).toBe(false);
    expect(tool.name).toBe('plain_tool');
    expect(tool.description).toBe('A tool.');
  });
});

describe('BaseTool.defersResponse', () => {
  it('defaults to false', () => {
    const tool = new SimpleTool({name: 'simple', description: 'a tool'});

    expect(tool.defersResponse).toBe(false);
  });

  it('can be set to true after construction', () => {
    const tool = new SimpleTool({name: 'simple', description: 'a tool'});

    tool.defersResponse = true;

    expect(tool.defersResponse).toBe(true);
  });

  it('is true on a subclass that overrides it', () => {
    const tool = new DeferringTool({
      name: 'deferring_tool',
      description: 'A tool.',
    });

    expect(tool.defersResponse).toBe(true);
  });

  it('does not mark a deferring tool as long running', () => {
    const tool = new DeferringTool({
      name: 'deferring_tool',
      description: 'A tool.',
    });

    expect(tool.isLongRunning).toBe(false);
  });

  it('stays false on a tool constructed as long running', () => {
    const tool = new SimpleTool({
      name: 'long_running_tool',
      description: 'A tool.',
      isLongRunning: true,
    });

    expect(tool.defersResponse).toBe(false);
  });
});

describe('BaseTool.fromConfig', () => {
  it('returns an instance of the class it is called on', async () => {
    const tool = await SimpleTool.fromConfig(
      {name: 'my_tool', description: 'does something'},
      '/abs/path/to/agent.yaml',
    );

    expect(tool).toBeInstanceOf(SimpleTool);
    expect(tool.name).toBe('my_tool');
    expect(tool.description).toBe('does something');
  });

  it('forwards isLongRunning', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'my_tool',
      description: 'does something',
      isLongRunning: true,
    });

    expect(tool.isLongRunning).toBe(true);
  });

  it('leaves isLongRunning false when the config omits it', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'my_tool',
      description: 'does something',
    });

    expect(tool.isLongRunning).toBe(false);
  });

  it('forwards a key the base class does not read', async () => {
    const tool = await LabelledTool.fromConfig({
      name: 'my_tool',
      description: 'does something',
      label: 'from-config',
    });

    if (!(tool instanceof LabelledTool)) {
      expect.fail(`expected a LabelledTool, got ${tool.constructor.name}`);
    }
    expect(tool.label).toBe('from-config');
  });

  it('leaves defersResponse false on the tool it builds', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'my_tool',
      description: 'does something',
    });

    expect(tool.defersResponse).toBe(false);
  });

  it('uses a subclass override that narrows the config type', async () => {
    const tool = await NarrowTool.fromConfig(
      {target: 'somewhere'},
      '/abs/path/to/agent.yaml',
    );

    expect(tool).toBeInstanceOf(NarrowTool);
    expect(tool.target).toBe('somewhere');
  });

  it('rejects a null config', async () => {
    await expectBadConfig(parseToolConfig('null'), 'must be a non-null object');
  });

  it('rejects a config that is a function', async () => {
    await expectBadConfig(() => undefined, 'must be a non-null object');
  });

  it('rejects a config with no name', async () => {
    await expectBadConfig(
      {description: 'does something'},
      '`name` must be a non-empty string',
    );
  });

  it('rejects a name that is not a string', async () => {
    await expectBadConfig(
      parseToolConfig('{"name": 7, "description": "does something"}'),
      '`name` must be a non-empty string',
    );
  });

  it('rejects an empty name', async () => {
    await expectBadConfig(
      {name: '', description: 'does something'},
      '`name` must be a non-empty string',
    );
  });

  it('rejects a config with no description', async () => {
    await expectBadConfig({name: 'my_tool'}, '`description` must be a string');
  });

  it('rejects a description that is not a string', async () => {
    await expectBadConfig(
      parseToolConfig('{"name": "my_tool", "description": []}'),
      '`description` must be a string',
    );
  });

  it('rejects an isLongRunning that is not a boolean', async () => {
    await expectBadConfig(
      parseToolConfig(
        '{"name": "my_tool", "description": "does something", "isLongRunning": "yes"}',
      ),
      '`isLongRunning` must be a boolean',
    );
  });

  it('carries customMetadata through', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
      isLongRunning: true,
      customMetadata: {'my.vendor.key': 'v'},
    });

    expect(tool.isLongRunning).toBe(true);
    expect(tool.customMetadata).toEqual({'my.vendor.key': 'v'});
  });

  it('leaves customMetadata undefined when the config omits it', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
    });

    expect(tool.customMetadata).toBeUndefined();
  });

  it('carries responseScheduling through', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
      responseScheduling: FunctionResponseScheduling.SILENT,
    });

    expect(tool.responseScheduling).toBe(FunctionResponseScheduling.SILENT);
  });

  it('leaves responseScheduling undefined when the config omits it', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
    });

    expect(tool.responseScheduling).toBeUndefined();
  });

  it('rejects a responseScheduling outside the enum', async () => {
    await expectBadConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        responseScheduling: 'EVENTUALLY',
      },
      '`responseScheduling` must be one of SCHEDULING_UNSPECIFIED, SILENT, ' +
        'WHEN_IDLE, INTERRUPT',
    );
  });

  it('rejects an array customMetadata', async () => {
    await expectBadConfig(
      parseToolConfig(
        '{"name": "plain_tool", "description": "A tool.", "customMetadata": ["a"]}',
      ),
      '`customMetadata` must be an object',
    );
  });

  it('rejects a null customMetadata', async () => {
    await expectBadConfig(
      parseToolConfig(
        '{"name": "plain_tool", "description": "A tool.", "customMetadata": null}',
      ),
      '`customMetadata` must be an object',
    );
  });

  it('accepts an explicit undefined for an optional key', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
      isLongRunning: undefined,
      customMetadata: undefined,
    });

    expect(tool.isLongRunning).toBe(false);
    expect(tool.customMetadata).toBeUndefined();
  });

  it('keeps a key the base implementation does not read off the instance', async () => {
    const tool = await SimpleTool.fromConfig({
      name: 'plain_tool',
      description: 'A tool.',
      apiKeyEnvVar: 'MY_KEY',
    });

    expect(tool.name).toBe('plain_tool');
    expect(Object.keys(tool)).not.toContain('apiKeyEnvVar');
  });

  it('returns an instance of the subclass it is called on', async () => {
    const config = {name: 'plain_tool', description: 'A tool.'};

    const plain = await SimpleTool.fromConfig(config);
    const other = await OtherSimpleTool.fromConfig(config);

    expect(plain).toBeInstanceOf(SimpleTool);
    expect(other).toBeInstanceOf(OtherSimpleTool);
    expect(other).not.toBeInstanceOf(SimpleTool);
  });

  it('uses a subclass override that reads the config file path', async () => {
    const configAbsPath = '/abs/path/agent.yaml';

    const tool = await ConfigPathTool.fromConfig(
      {name: 'ignored'},
      configAbsPath,
    );

    expect(tool.description).toBe(`loaded from ${configAbsPath}`);
  });

  it('does not echo the config back in the error message', async () => {
    const error = await rejectionOf(
      parseToolConfig('{"description": "does something", "apiKey": "s3cret"}'),
    );

    expect(error.message).not.toContain('s3cret');
  });
});
