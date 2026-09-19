/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests do not cover: the capability gate, the
 * filter, and the settings and credential the toolset hands each tool body.
 */

import {
  Context,
  GcsAdminToolset,
  GcsCapability,
  GcsCredentialsConfig,
  GcsToolSettings,
  GoogleTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {GoogleCredentialsManager} from '../../../src/tools/google_credentials.js';
import {gcsFakeHooks, resetGcsFakes, storageInstances} from './gcs_fakes.js';

vi.mock('@google-cloud/storage', async () => ({
  Storage: (await import('./gcs_fakes.js')).FakeStorage,
}));

const READ_WRITE: GcsToolSettings = {
  capabilities: [GcsCapability.READ_WRITE],
};
const READ_ONLY: GcsToolSettings = {capabilities: [GcsCapability.READ_ONLY]};

function credentialsConfig(): GcsCredentialsConfig {
  return new GcsCredentialsConfig({clientId: 'abc', clientSecret: 'def'});
}

function makeContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

/** An authorized client, so the tool body runs instead of asking for consent. */
function authorizedClient(): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: 'valid_token',
    expiry_date: Date.now() + 60 * 60 * 1000,
  });
  return client;
}

async function toolNames(toolset: GcsAdminToolset): Promise<string[]> {
  const tools = await toolset.getTools();
  return tools.map((tool) => tool.name).sort();
}

describe('GcsAdminToolset capability gate', () => {
  it('exposes the read-only default when no settings were given', async () => {
    const names = await toolNames(new GcsAdminToolset());

    expect(names).toEqual(['gcs_get_bucket', 'gcs_list_buckets']);
  });

  it('never builds a write tool under READ_ONLY, even when a filter names one', async () => {
    const toolset = new GcsAdminToolset({
      gcsToolSettings: READ_ONLY,
      toolFilter: ['delete_bucket', 'get_bucket'],
    });

    expect(await toolNames(toolset)).toEqual(['gcs_get_bucket']);
  });

  it('exposes no tool when the capabilities are empty', async () => {
    const toolset = new GcsAdminToolset({gcsToolSettings: {capabilities: []}});

    expect(await toolNames(toolset)).toEqual([]);
  });
});

describe('GcsAdminToolset filter', () => {
  it('matches the unprefixed operation and returns the prefixed tool', async () => {
    const toolset = new GcsAdminToolset({
      gcsToolSettings: READ_WRITE,
      toolFilter: ['list_buckets', 'delete_bucket'],
    });

    expect(await toolNames(toolset)).toEqual([
      'gcs_delete_bucket',
      'gcs_list_buckets',
    ]);
  });

  it('does not match the prefixed name', async () => {
    const toolset = new GcsAdminToolset({toolFilter: ['gcs_get_bucket']});

    expect(await toolNames(toolset)).toEqual([]);
  });

  it('treats an empty list as no filter', async () => {
    const toolset = new GcsAdminToolset({
      gcsToolSettings: READ_WRITE,
      toolFilter: [],
    });

    expect(await toolNames(toolset)).toHaveLength(5);
  });

  it('applies a predicate when a context is given', async () => {
    const toolset = new GcsAdminToolset({
      toolFilter: (tool) => tool.name === 'gcs_list_buckets',
    });

    const tools = await toolset.getTools(
      new ReadonlyContext(makeContext().invocationContext),
    );

    expect(tools.map((tool) => tool.name)).toEqual(['gcs_list_buckets']);
  });

  it('admits every tool and warns when a predicate has no context', async () => {
    const {logger} = await import('../../../src/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolset = new GcsAdminToolset({toolFilter: () => false});

    const names = await toolNames(toolset);

    expect(names).toEqual(['gcs_get_bucket', 'gcs_list_buckets']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('was called without a ReadonlyContext'),
    );
    warn.mockRestore();
  });
});

describe('GcsAdminToolset tool bodies', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('hands the resolved credential to the tool body', async () => {
    const client = authorizedClient();
    vi.spyOn(
      GoogleCredentialsManager.prototype,
      'getValidCredentials',
    ).mockResolvedValue(client);
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = ['b'];
    };
    const toolset = new GcsAdminToolset({
      credentialsConfig: credentialsConfig(),
      toolFilter: ['list_buckets'],
    });
    const [tool] = await toolset.getTools();

    const result = await tool.runAsync({
      args: {projectId: 'p'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['b']});
    // Handed over through `asStorageAuthClient`, so the client answers for the
    // resolved credential rather than being that object.
    expect(
      await storageInstances[0].options.authClient?.getRequestHeaders(),
    ).toEqual({authorization: 'Bearer valid_token'});
    vi.restoreAllMocks();
  });

  it('routes every tool it exposes to its bucket operation', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.metadata.set('b', {name: 'b', location: 'US'});
    };
    const toolset = new GcsAdminToolset({gcsToolSettings: READ_WRITE});
    const tools = await toolset.getTools();
    const toolContext = makeContext();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const calls: Array<[string, Record<string, unknown>, unknown]> = [
      ['gcs_get_bucket', {bucketName: 'b'}, {name: 'b', location: 'US'}],
      ['gcs_list_buckets', {projectId: 'p'}, []],
      [
        'gcs_create_bucket',
        {projectId: 'p', bucketName: 'b', location: 'US'},
        'Bucket b created successfully.',
      ],
      [
        'gcs_update_bucket',
        {bucketName: 'b', versioningEnabled: true},
        'Bucket b updated successfully.',
      ],
      [
        'gcs_delete_bucket',
        {bucketName: 'b'},
        'Bucket b deleted successfully.',
      ],
    ];

    for (const [name, args, results] of calls) {
      const tool = byName.get(name);
      if (!tool) {
        expect.fail(`the toolset did not expose ${name}`);
      }
      await expect(tool.runAsync({args, toolContext})).resolves.toEqual({
        status: 'SUCCESS',
        results,
      });
    }

    // One client per call, in the order the calls were made above.
    expect(storageInstances).toHaveLength(5);
    const [, , create, update, remove] = storageInstances;
    expect(create.createBucketRequests).toEqual([
      {name: 'b', metadata: {location: 'US'}},
    ]);
    expect(update.bucket('b').patches).toEqual([{versioning: {enabled: true}}]);
    expect(remove.bucket('b').deleteCalls).toBe(1);
  });

  it('hands GcsToolSettings to the tool body, as the toolset configures it', async () => {
    let received: GcsToolSettings | undefined;
    const tool = new GoogleTool<undefined, GcsToolSettings>({
      name: 'gcs_probe',
      description: 'Reports the settings it was handed.',
      toolSettings: READ_WRITE,
      execute: (_input, _toolContext, google) => {
        received = google?.settings;
        return 'done';
      },
    });

    await tool.runAsync({args: {}, toolContext: makeContext()});

    expect(received).toBe(READ_WRITE);
  });

  it('returns the authorization prompt while a consent flow is pending', async () => {
    vi.spyOn(
      GoogleCredentialsManager.prototype,
      'getValidCredentials',
    ).mockResolvedValue(undefined);
    const toolset = new GcsAdminToolset({
      credentialsConfig: credentialsConfig(),
      toolFilter: ['get_bucket'],
    });
    const [tool] = await toolset.getTools();

    const result = await tool.runAsync({
      args: {bucketName: 'b'},
      toolContext: makeContext(),
    });

    expect(result).toBe(
      'User authorization is required to access Google services for ' +
        'gcs_get_bucket. Please complete the authorization flow.',
    );
    expect(storageInstances).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('resolves close(), because each call drops its own client', async () => {
    await expect(new GcsAdminToolset().close()).resolves.toBeUndefined();
  });
});
