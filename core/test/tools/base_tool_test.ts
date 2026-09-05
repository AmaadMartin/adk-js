/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolParams,
  ToolArgsConfig,
  ToolErrorType,
  ToolExecutionError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

  it('does not echo the config back in the error message', async () => {
    const error = await rejectionOf(
      parseToolConfig('{"description": "does something", "apiKey": "s3cret"}'),
    );

    expect(error.message).not.toContain('s3cret');
  });
});
