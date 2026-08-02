/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  GCSAdminToolset,
  GCSCredentialsConfig,
  GCSToolset,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createToolContext, getTool} from './gcs_test_utils.js';

const {StorageMock, fakes} = vi.hoisted(() => {
  const bucket = {getMetadata: vi.fn()};
  const storage = {bucket: vi.fn(() => bucket), getBuckets: vi.fn()};
  return {StorageMock: vi.fn(() => storage), fakes: {bucket, storage}};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

const USER_AGENT_PATTERN = /^adk-gcs-tool google-adk\/\d/;

describe('getGcsClient', () => {
  let toolContext: Context;

  /** Runs `gcs_get_bucket`, which builds a client without a project. */
  async function callGetBucket(toolset: GCSToolset): Promise<void> {
    const tool = await getTool(toolset, 'gcs_get_bucket');
    await tool.runAsync({args: {bucket_name: 'test-bucket'}, toolContext});
  }

  /** Runs `gcs_list_buckets`, which builds a client for the given project. */
  async function callListBuckets(
    toolset: GCSAdminToolset,
    projectId: string,
  ): Promise<void> {
    const tool = await getTool(toolset, 'gcs_list_buckets');
    await tool.runAsync({args: {project_id: projectId}, toolContext});
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    fakes.bucket.getMetadata.mockResolvedValue([{}]);
    fakes.storage.getBuckets.mockResolvedValue([[]]);
    toolContext = await createToolContext();
  });

  it('builds an Application Default Credentials client with the ADK user agent', async () => {
    await callGetBucket(new GCSToolset());

    expect(StorageMock).toHaveBeenCalledTimes(1);
    expect(StorageMock).toHaveBeenCalledWith({
      userAgent: expect.stringMatching(USER_AGENT_PATTERN),
    });
  });

  it('builds the client from the credentials config', async () => {
    const credentialsConfig = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      projectId: 'configured-project',
    });

    await callGetBucket(new GCSToolset({credentialsConfig}));

    expect(StorageMock).toHaveBeenCalledTimes(1);
    expect(StorageMock).toHaveBeenCalledWith({
      clientOptions: {clientId: 'abc', clientSecret: 'def'},
      scopes: credentialsConfig.scopes,
      projectId: 'configured-project',
      userAgent: expect.stringMatching(USER_AGENT_PATTERN),
    });
  });

  it('reuses one client for repeated calls with the same config', async () => {
    const credentialsConfig = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const toolset = new GCSToolset({credentialsConfig});

    await callGetBucket(toolset);
    await callGetBucket(toolset);

    expect(StorageMock).toHaveBeenCalledTimes(1);
  });

  it('builds a separate client per project', async () => {
    const credentialsConfig = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const toolset = new GCSToolset({credentialsConfig});
    const adminToolset = new GCSAdminToolset({credentialsConfig});

    await callGetBucket(toolset);
    await callListBuckets(adminToolset, 'project-one');
    await callListBuckets(adminToolset, 'project-two');
    await callListBuckets(adminToolset, 'project-one');

    expect(StorageMock).toHaveBeenCalledTimes(3);
    expect(StorageMock).toHaveBeenCalledWith(
      expect.objectContaining({projectId: 'project-one'}),
    );
    expect(StorageMock).toHaveBeenCalledWith(
      expect.objectContaining({projectId: 'project-two'}),
    );
  });

  it('drops the cache once it overflows', async () => {
    const adminToolset = new GCSAdminToolset({
      credentialsConfig: new GCSCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      }),
    });

    for (let i = 0; i < 16; i++) {
      await callListBuckets(adminToolset, `project-${i}`);
    }
    expect(StorageMock).toHaveBeenCalledTimes(16);

    // The 17th project evicts the whole cache, so the first one is rebuilt.
    await callListBuckets(adminToolset, 'project-16');
    await callListBuckets(adminToolset, 'project-0');

    expect(StorageMock).toHaveBeenCalledTimes(18);
  });
});
