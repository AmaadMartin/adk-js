/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  getLogger,
  InputValidationError,
  Logger,
  setLogger,
  ToolArgsConfig,
} from '@google/adk';
import {FunctionResponseScheduling} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

class PlainTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

/** Collects the warnings a call emits, in place of the console logger. */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }

  log(): void {}
  debug(): void {}
  info(): void {}
  error(): void {}
  setLogLevel(): void {}
}

class OtherPlainTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
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

  it('ignores a key the base implementation does not recognize', async () => {
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

describe('BaseTool.fromConfig unrecognized keys', () => {
  const CONFIG_PATH = '/abs/path/agent.yaml';
  let recording: RecordingLogger;
  let previous: Logger;

  beforeEach(() => {
    previous = getLogger();
    recording = new RecordingLogger();
    setLogger(recording);
  });

  afterEach(() => {
    setLogger(previous);
  });

  it('warns once for each key it does not recognize', async () => {
    await PlainTool.fromConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        is_long_running: true,
        retries: 3,
      },
      CONFIG_PATH,
    );

    expect(recording.warnings).toEqual([
      'Unsupported parsing for tool config argument: is_long_running.',
      'Unsupported parsing for tool config argument: retries.',
    ]);
  });

  it('does not warn when it recognizes every key', async () => {
    await PlainTool.fromConfig(
      {
        name: 'plain_tool',
        description: 'A tool.',
        isLongRunning: true,
        customMetadata: {'my.vendor.key': 'v'},
        responseScheduling: FunctionResponseScheduling.SILENT,
      },
      CONFIG_PATH,
    );

    expect(recording.warnings).toEqual([]);
  });

  it('warns before it rejects a bad key, so both problems are visible', async () => {
    await expect(
      PlainTool.fromConfig({description: 'A tool.', retries: 3}, CONFIG_PATH),
    ).rejects.toBeInstanceOf(InputValidationError);

    expect(recording.warnings).toEqual([
      'Unsupported parsing for tool config argument: retries.',
    ]);
  });
});
