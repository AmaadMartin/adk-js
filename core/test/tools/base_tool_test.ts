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
  PluginManager,
  RunAsyncToolRequest,
  toBaseToolParams,
  ToolArgsConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Parameters of a tool that carries one option the base does not know. */
interface ConfigurableToolParams extends BaseToolParams {
  myOption?: string;
}

/** Identifies {@link ConfigurableTool} without `instanceof`. */
const CONFIGURABLE_TOOL_SIGNATURE = Symbol.for(
  'google.adk.test.configurableTool',
);

/** A tool that accepts an extra option and implements `runAsync`. */
class ConfigurableTool extends BaseTool {
  readonly [CONFIGURABLE_TOOL_SIGNATURE] = true;
  readonly myOption?: string;

  constructor(params: ConfigurableToolParams) {
    super(params);
    this.myOption = params.myOption;
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return {result: 'configurable'};
  }
}

function isConfigurableTool(tool: BaseTool): tool is ConfigurableTool {
  return CONFIGURABLE_TOOL_SIGNATURE in tool;
}

/** A tool that runs on the server, so it implements no `runAsync`. */
class ServerSideTool extends BaseTool {}

function createRunRequest(): RunAsyncToolRequest {
  const invocationContext = new InvocationContext({
    invocationId: 'inv_base_tool',
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
  });
  return {args: {}, toolContext: new Context({invocationContext})};
}

describe('BaseTool.defersResponse', () => {
  it('defaults to false', () => {
    const tool = new ConfigurableTool({name: 'a', description: 'd'});

    expect(tool.defersResponse).toBe(false);
  });

  it('can be set to true after construction', () => {
    const tool = new ConfigurableTool({name: 'a', description: 'd'});

    tool.defersResponse = true;

    expect(tool.defersResponse).toBe(true);
  });

  it('is per instance, not shared by the class', () => {
    const deferring = new ConfigurableTool({name: 'a', description: 'd'});
    const other = new ConfigurableTool({name: 'b', description: 'd'});

    deferring.defersResponse = true;

    expect(other.defersResponse).toBe(false);
  });

  it('is not a constructor option', async () => {
    const tool = await ConfigurableTool.fromConfig(
      {name: 'a', description: 'd', defersResponse: true},
      '/abs/agent.yaml',
    );

    expect(tool.defersResponse).toBe(false);
  });
});

describe('BaseTool.runAsync', () => {
  it('rejects with the tool name when the subclass does not implement it', async () => {
    const tool = new ServerSideTool({
      name: 'server_side',
      description: 'runs inside the model',
    });

    await expect(tool.runAsync(createRunRequest())).rejects.toThrow(
      'Tool server_side does not implement runAsync().',
    );
  });

  it('does not shadow a subclass implementation', async () => {
    const tool = new ConfigurableTool({name: 'a', description: 'd'});

    await expect(tool.runAsync(createRunRequest())).resolves.toEqual({
      result: 'configurable',
    });
  });
});

describe('BaseTool.fromConfig', () => {
  it('builds an instance of the class it is called on', async () => {
    const tool = await ConfigurableTool.fromConfig(
      {name: 'a', description: 'd'},
      '/abs/agent.yaml',
    );

    expect(isConfigurableTool(tool)).toBe(true);
    expect(tool.name).toBe('a');
    expect(tool.description).toBe('d');
  });

  it('reads isLongRunning from the config', async () => {
    const tool = await ConfigurableTool.fromConfig(
      {name: 'a', description: 'd', isLongRunning: true},
      '/abs/agent.yaml',
    );

    expect(tool.isLongRunning).toBe(true);
  });

  it('defaults isLongRunning to false when the config omits it', async () => {
    const tool = await ConfigurableTool.fromConfig(
      {name: 'a', description: 'd'},
      '/abs/agent.yaml',
    );

    expect(tool.isLongRunning).toBe(false);
  });

  it('forwards a key the base does not recognize to the constructor', async () => {
    const tool = await ConfigurableTool.fromConfig(
      {name: 'a', description: 'd', myOption: 'kept'},
      '/abs/agent.yaml',
    );

    if (!isConfigurableTool(tool)) {
      expect.fail('fromConfig did not return a ConfigurableTool');
    }
    expect(tool.myOption).toBe('kept');
  });

  it('uses a subclass override and hands it configAbsPath unchanged', async () => {
    const seenPaths: string[] = [];
    class OverridingTool extends BaseTool {
      static override async fromConfig(
        config: ToolArgsConfig,
        configAbsPath: string,
      ): Promise<BaseTool> {
        seenPaths.push(configAbsPath);
        return new OverridingTool(toBaseToolParams(config));
      }
    }

    const tool = await OverridingTool.fromConfig(
      {name: 'overridden', description: 'd'},
      '/abs/dir/agent.yaml',
    );

    expect(seenPaths).toEqual(['/abs/dir/agent.yaml']);
    expect(tool.name).toBe('overridden');
  });

  it('does not mutate the config it is given', async () => {
    const config: ToolArgsConfig = {
      name: 'a',
      description: 'd',
      myOption: 'kept',
    };

    await ConfigurableTool.fromConfig(config, '/abs/agent.yaml');

    expect(config).toEqual({name: 'a', description: 'd', myOption: 'kept'});
  });
});
