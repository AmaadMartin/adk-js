/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  GcsAdminToolset,
  GcsCapability,
  getLogger,
  Logger,
  ReadonlyContext,
  setLogger,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  bucketNames: [] as string[],
  getBuckets: vi.fn(),
  createBucket: vi.fn(),
  getMetadata: vi.fn(),
  setMetadata: vi.fn(),
  bucketDelete: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    getBuckets = mocks.getBuckets;
    createBucket = mocks.createBucket;

    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }

    bucket(name: string) {
      mocks.bucketNames.push(name);
      return {
        getMetadata: mocks.getMetadata,
        setMetadata: mocks.setMetadata,
        delete: mocks.bucketDelete,
      };
    }
  },
}));

class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  error(): void {}
  setLogLevel(): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }
}

const READ_TOOL_NAMES = ['gcs_get_bucket', 'gcs_list_buckets'];
const WRITE_TOOL_NAMES = [
  'gcs_create_bucket',
  'gcs_update_bucket',
  'gcs_delete_bucket',
];

const readWrite = {capabilities: [GcsCapability.READ_WRITE]};

const emptyContext = {} as Context;

/**
 * Returns the named tool of a read-write toolset, failing the test when the
 * toolset does not expose it.
 */
async function readWriteTool(name: string): Promise<BaseTool> {
  const toolset = new GcsAdminToolset({settings: readWrite});
  const tool = (await toolset.getTools()).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) {
    expect.fail(`the toolset did not expose ${name}`);
  }
  return tool;
}

beforeEach(() => {
  mocks.clientOptions.length = 0;
  mocks.bucketNames.length = 0;
  vi.clearAllMocks();
});

describe('GcsAdminToolset.getTools', () => {
  it('exposes only the read tools by default', async () => {
    const tools = await new GcsAdminToolset().getTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual(READ_TOOL_NAMES);
  });

  it('exposes the read tools then the write tools for a read-write toolset', async () => {
    const toolset = new GcsAdminToolset({settings: readWrite});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual([
      ...READ_TOOL_NAMES,
      ...WRITE_TOOL_NAMES,
    ]);
  });

  it('exposes no tool when the settings allow no capability', async () => {
    const toolset = new GcsAdminToolset({settings: {capabilities: []}});

    expect(await toolset.getTools()).toStrictEqual([]);
  });

  it('matches a string filter against the names the model sees', async () => {
    const toolset = new GcsAdminToolset({
      settings: readWrite,
      toolFilter: ['gcs_get_bucket', 'gcs_delete_bucket'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual([
      'gcs_get_bucket',
      'gcs_delete_bucket',
    ]);
  });

  it('drops every tool when a string filter omits the prefix', async () => {
    const toolset = new GcsAdminToolset({toolFilter: ['get_bucket']});

    expect(await toolset.getTools()).toStrictEqual([]);
  });

  it('applies no filter for an empty string array', async () => {
    const toolset = new GcsAdminToolset({toolFilter: []});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual(READ_TOOL_NAMES);
  });

  it('applies a predicate filter when a context is given', async () => {
    const toolset = new GcsAdminToolset({
      toolFilter: (tool) => tool.name === 'gcs_list_buckets',
    });

    const tools = await toolset.getTools({} as ReadonlyContext);

    expect(tools.map((tool) => tool.name)).toStrictEqual(['gcs_list_buckets']);
  });

  it('closes and releases nothing', async () => {
    await expect(new GcsAdminToolset().close()).resolves.toBeUndefined();
  });
});

describe('GcsAdminToolset.getTools without a context', () => {
  let previousLogger: Logger;
  let recorder: RecordingLogger;

  beforeEach(() => {
    previousLogger = getLogger();
    recorder = new RecordingLogger();
    setLogger(recorder);
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('keeps every tool and warns that the predicate filter was skipped', async () => {
    const toolset = new GcsAdminToolset({
      toolFilter: (tool) => tool.name === 'gcs_list_buckets',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual(READ_TOOL_NAMES);
    expect(
      recorder.warnings.filter((warning) =>
        warning.includes('ToolPredicate toolFilter'),
      ),
    ).toHaveLength(1);
  });
});

describe('GcsAdminToolset tool execution', () => {
  it('builds the storage client from the toolset options', async () => {
    mocks.getBuckets.mockResolvedValue([[{name: 'test-bucket'}]]);
    const toolset = new GcsAdminToolset({
      storageOptions: {apiEndpoint: 'https://storage.example.com'},
    });
    const tool = (await toolset.getTools()).find(
      (candidate) => candidate.name === 'gcs_list_buckets',
    );
    if (!tool) {
      expect.fail('the toolset did not expose gcs_list_buckets');
    }

    const result = await tool.runAsync({
      args: {project_id: 'test-project'},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
    });
    expect(mocks.clientOptions).toStrictEqual([
      {
        userAgent: expect.stringContaining('adk-gcs-tool google-adk/'),
        apiEndpoint: 'https://storage.example.com',
        projectId: 'test-project',
      },
    ]);
  });

  it('reads the bucket metadata for gcs_get_bucket', async () => {
    mocks.getMetadata.mockResolvedValue([{name: 'test-bucket'}]);
    const tool = await readWriteTool('gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: {name: 'test-bucket'},
    });
    expect(mocks.getMetadata).toHaveBeenCalledOnce();
  });

  it('creates the bucket for gcs_create_bucket', async () => {
    mocks.createBucket.mockResolvedValue([{name: 'test-bucket'}]);
    const tool = await readWriteTool('gcs_create_bucket');

    const result = await tool.runAsync({
      args: {project_id: 'test-project', bucket_name: 'test-bucket'},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket created successfully.',
    });
    expect(mocks.createBucket).toHaveBeenCalledWith('test-bucket', {});
  });

  it('patches the bucket for gcs_update_bucket', async () => {
    mocks.setMetadata.mockResolvedValue([{}]);
    const tool = await readWriteTool('gcs_update_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket', versioning_enabled: true},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket updated successfully.',
    });
    expect(mocks.setMetadata).toHaveBeenCalledWith({
      versioning: {enabled: true},
    });
  });

  it('deletes the bucket for gcs_delete_bucket', async () => {
    mocks.bucketDelete.mockResolvedValue([{}]);
    const tool = await readWriteTool('gcs_delete_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket deleted successfully.',
    });
    expect(mocks.bucketDelete).toHaveBeenCalledOnce();
    expect(mocks.bucketNames).toStrictEqual(['test-bucket']);
  });

  it('rejects a call whose arguments do not match the schema', async () => {
    const tool = await readWriteTool('gcs_delete_bucket');

    await expect(
      tool.runAsync({args: {}, toolContext: emptyContext}),
    ).rejects.toThrow("Error in tool 'gcs_delete_bucket'");
    expect(mocks.bucketDelete).not.toHaveBeenCalled();
  });

  it('answers a traversing bucket name with an error and no request', async () => {
    const tool = await readWriteTool('gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: '../../../victim-bucket/o/secret.txt'},
      toolContext: emptyContext,
    });

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: expect.stringContaining('Invalid bucket name'),
    });
    expect(mocks.getMetadata).not.toHaveBeenCalled();
    expect(mocks.clientOptions).toStrictEqual([]);
  });
});
