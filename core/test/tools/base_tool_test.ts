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
  InputValidationError,
  InvocationContext,
  LlmRequest,
  PluginManager,
  ToolArgsConfig,
  ToolExecutionError,
} from '@google/adk';
import {FunctionDeclaration, FunctionResponseScheduling} from '@google/genai';
import {describe, expect, it} from 'vitest';

class PlainTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

class OtherPlainTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

/**
 * A tool with an optional option of its own. It relies on the inherited
 * `fromConfig`, so it pins that the base seam forwards a key it does not
 * recognize to the subclass constructor.
 */
class UnitsTool extends BaseTool {
  readonly units: string;

  constructor(params: BaseToolParams & {units?: string}) {
    super(params);
    this.units = params.units ?? 'metric';
  }

  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

/** Narrows a `fromConfig` result, whose declared type is `BaseTool`. */
function asUnitsTool(tool: BaseTool): UnitsTool {
  if (!(tool instanceof UnitsTool)) {
    expect.fail(`expected a UnitsTool, got ${tool.name}`);
  }
  return tool;
}

/** A tool whose own config seam reads the config file path. */
class ConfigPathTool extends BaseTool {
  static override async fromConfig(
    config: ToolArgsConfig,
    configAbsPath: string,
  ): Promise<ConfigPathTool> {
    return new ConfigPathTool({
      name: String(config['name']),
      description: `loaded from ${configAbsPath}`,
    });
  }

  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

describe('BaseTool.customMetadata', () => {
  it('is undefined when the constructor params omit it', () => {
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    expect(tool.customMetadata).toBeUndefined();
  });

  it('is the metadata passed through BaseToolParams', () => {
    const tool = new PlainTool({
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
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    tool.customMetadata = {'my.vendor.key': 'v'};

    expect(tool.customMetadata).toEqual({'my.vendor.key': 'v'});
  });

  it('keeps existing keys when a key is added after construction', () => {
    const tool = new PlainTool({
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
    const tool = new PlainTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v'},
    });

    expect(tool.isLongRunning).toBe(false);
    expect(tool.name).toBe('plain_tool');
    expect(tool.description).toBe('A tool.');
  });
});

/** A tool whose matching `FunctionResponse` is supplied by something else. */
class DeferringTool extends BaseTool {
  override readonly defersResponse = true;

  override async runAsync(): Promise<unknown> {
    return null;
  }
}

describe('BaseTool.defersResponse', () => {
  it('defaults to false', () => {
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    expect(tool.defersResponse).toBe(false);
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
    const tool = new PlainTool({
      name: 'long_running_tool',
      description: 'A tool.',
      isLongRunning: true,
    });

    expect(tool.defersResponse).toBe(false);
  });

  it('can be assigned after construction', () => {
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    tool.defersResponse = true;

    expect(tool.defersResponse).toBe(true);
  });
});

/**
 * A tool the model runs on its own side, as the built-in search tools do. It
 * contributes a declaration and has no client-side body, so it declares no
 * `runAsync`. Compiling at all is half of what this fixture pins.
 */
class DeclarationOnlyTool extends BaseTool {
  override _getDeclaration(): FunctionDeclaration {
    return {name: this.name, description: this.description};
  }
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('BaseTool.runAsync', () => {
  const REQUEST = {args: {}, toolContext: createToolContext()};

  it('rejects with a message naming the tool when the subclass declares none', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'declaration_only_tool',
      description: 'A tool the model runs.',
    });

    await expect(tool.runAsync(REQUEST)).rejects.toThrow(
      'Tool declaration_only_tool does not implement runAsync.',
    );
  });

  it('rejects with a plain Error, so no error type reaches the tool span', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'declaration_only_tool',
      description: 'A tool the model runs.',
    });

    const error = await tool.runAsync(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ToolExecutionError);
  });

  it('still lets a tool with no client-side body contribute its declaration', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'declaration_only_tool',
      description: 'A tool the model runs.',
    });
    const llmRequest: LlmRequest = {
      config: {},
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      llmRequest,
      toolContext: REQUEST.toolContext,
    });

    expect(llmRequest.config?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'declaration_only_tool',
            description: 'A tool the model runs.',
          },
        ],
      },
    ]);
  });

  it('leaves a subclass implementation in place', async () => {
    const tool: BaseTool = new PlainTool({
      name: 'plain_tool',
      description: 'A tool.',
    });

    await expect(tool.runAsync(REQUEST)).resolves.toEqual({result: 'ok'});
  });
});

describe('BaseTool.fromConfig', () => {
  const CONFIG_PATH = '/abs/path/agent.yaml';

  it('builds a tool from the required keys alone', async () => {
    const tool = await PlainTool.fromConfig(
      {name: 'plain_tool', description: 'A tool.'},
      CONFIG_PATH,
    );

    expect(tool).toBeInstanceOf(PlainTool);
    expect(tool.name).toBe('plain_tool');
    expect(tool.description).toBe('A tool.');
    expect(tool.isLongRunning).toBe(false);
    expect(tool.customMetadata).toBeUndefined();
  });

  it('carries isLongRunning and customMetadata through', async () => {
    const tool = await PlainTool.fromConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        isLongRunning: true,
        customMetadata: {'my.vendor.key': 'v'},
      },
      CONFIG_PATH,
    );

    expect(tool.isLongRunning).toBe(true);
    expect(tool.customMetadata).toEqual({'my.vendor.key': 'v'});
  });

  it('carries responseScheduling through', async () => {
    const tool = await PlainTool.fromConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        responseScheduling: FunctionResponseScheduling.SILENT,
      },
      CONFIG_PATH,
    );

    expect(tool.responseScheduling).toBe(FunctionResponseScheduling.SILENT);
  });

  it('leaves responseScheduling undefined when the config omits it', async () => {
    const tool = await PlainTool.fromConfig(
      {name: 'plain_tool', description: 'A tool.'},
      CONFIG_PATH,
    );

    expect(tool.responseScheduling).toBeUndefined();
  });

  it('rejects a responseScheduling outside the enum', async () => {
    await expect(
      PlainTool.fromConfig(
        {
          name: 'plain_tool',
          description: 'A tool.',
          responseScheduling: 'EVENTUALLY',
        },
        CONFIG_PATH,
      ),
    ).rejects.toThrow(
      'Invalid tool config: "responseScheduling" must be one of ' +
        'SCHEDULING_UNSPECIFIED, SILENT, WHEN_IDLE, INTERRUPT, got string.',
    );
  });

  it('forwards a key the base implementation does not recognize', async () => {
    const tool = await UnitsTool.fromConfig(
      {name: 'units_tool', description: 'A tool.', units: 'imperial'},
      CONFIG_PATH,
    );

    expect(asUnitsTool(tool).units).toBe('imperial');
  });

  it('leaves a subclass option at its default when the config omits it', async () => {
    const tool = await UnitsTool.fromConfig(
      {name: 'units_tool', description: 'A tool.'},
      CONFIG_PATH,
    );

    expect(asUnitsTool(tool).units).toBe('metric');
  });

  it('forwards a key no constructor reads without failing', async () => {
    const tool = await PlainTool.fromConfig(
      {name: 'plain_tool', description: 'A tool.', apiKeyEnvVar: 'MY_KEY'},
      CONFIG_PATH,
    );

    expect(tool.name).toBe('plain_tool');
    expect(Object.keys(tool)).not.toContain('apiKeyEnvVar');
  });

  it('rejects a missing name', async () => {
    await expect(
      PlainTool.fromConfig({description: 'A tool.'}, CONFIG_PATH),
    ).rejects.toThrow(
      'Invalid tool config: "name" must be a string, got undefined.',
    );
  });

  it('rejects a bad key with an InputValidationError', async () => {
    await expect(
      PlainTool.fromConfig({description: 'A tool.'}, CONFIG_PATH),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  it('rejects an empty name', async () => {
    await expect(
      PlainTool.fromConfig({name: '', description: 'A tool.'}, CONFIG_PATH),
    ).rejects.toThrow('Invalid tool config: "name" must not be empty.');
  });

  it('accepts an empty description', async () => {
    const tool = await PlainTool.fromConfig(
      {name: 'plain_tool', description: ''},
      CONFIG_PATH,
    );

    expect(tool.description).toBe('');
  });

  it('rejects a non-string name', async () => {
    await expect(
      PlainTool.fromConfig({name: 7, description: 'A tool.'}, CONFIG_PATH),
    ).rejects.toThrow(
      'Invalid tool config: "name" must be a string, got number.',
    );
  });

  it('rejects a non-string description', async () => {
    await expect(
      PlainTool.fromConfig(
        {name: 'plain_tool', description: null},
        CONFIG_PATH,
      ),
    ).rejects.toThrow(
      'Invalid tool config: "description" must be a string, got null.',
    );
  });

  it('rejects a non-boolean isLongRunning', async () => {
    await expect(
      PlainTool.fromConfig(
        {name: 'plain_tool', description: 'A tool.', isLongRunning: 'yes'},
        CONFIG_PATH,
      ),
    ).rejects.toThrow(
      'Invalid tool config: "isLongRunning" must be a boolean, got string.',
    );
  });

  it('rejects an array customMetadata', async () => {
    await expect(
      PlainTool.fromConfig(
        {name: 'plain_tool', description: 'A tool.', customMetadata: ['a']},
        CONFIG_PATH,
      ),
    ).rejects.toThrow(
      'Invalid tool config: "customMetadata" must be an object, got array.',
    );
  });

  it('rejects a null customMetadata', async () => {
    await expect(
      PlainTool.fromConfig(
        {name: 'plain_tool', description: 'A tool.', customMetadata: null},
        CONFIG_PATH,
      ),
    ).rejects.toThrow(
      'Invalid tool config: "customMetadata" must be an object, got null.',
    );
  });

  it('accepts an explicit undefined for an optional key', async () => {
    const tool = await PlainTool.fromConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        isLongRunning: undefined,
        customMetadata: undefined,
      },
      CONFIG_PATH,
    );

    expect(tool.isLongRunning).toBe(false);
    expect(tool.customMetadata).toBeUndefined();
  });

  it('returns an instance of the subclass it is called on', async () => {
    const config = {name: 'plain_tool', description: 'A tool.'};

    const plain = await PlainTool.fromConfig(config, CONFIG_PATH);
    const other = await OtherPlainTool.fromConfig(config, CONFIG_PATH);

    expect(plain).toBeInstanceOf(PlainTool);
    expect(other).toBeInstanceOf(OtherPlainTool);
    expect(other).not.toBeInstanceOf(PlainTool);
  });

  it('uses a subclass override instead of the base implementation', async () => {
    const tool = await ConfigPathTool.fromConfig(
      {name: 'ignored'},
      CONFIG_PATH,
    );

    expect(tool.description).toBe(`loaded from ${CONFIG_PATH}`);
  });
});
