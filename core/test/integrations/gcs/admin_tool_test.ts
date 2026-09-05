/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_gcs_admin_tool.py`, read at
 * `main` commit `a119dd77`. Each test keeps its reference name.
 *
 * adk-python calls the tool functions directly with a credentials object.
 * adk-js has no such function: the toolset builds the tools, so each test
 * calls the tool the toolset exposes.
 */

import {GcsCapabilities} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ADC_CREDENTIALS,
  createConfirmedToolContext,
  createToolContext,
  createToolset,
  getTool,
} from './gcs_test_utils.js';

const registry = await vi.hoisted(async () => {
  const {FakeStorageRegistry} = await import('./gcs_test_utils.js');
  return new FakeStorageRegistry();
});

vi.mock('@google-cloud/storage', () => ({Storage: registry.Storage}));

/** A read-write toolset authenticating as the agent's own identity. */
function readWriteToolset() {
  return createToolset({
    credentialsConfig: ADC_CREDENTIALS,
    gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
  });
}

describe('gcs admin tools', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('test_list_buckets', async () => {
    registry.reset({bucketNames: ['test-bucket']});
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'test-project'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['test-bucket']});
    expect(registry.only().options['projectId']).toBe('test-project');
  });

  it('test_list_buckets_pagination', async () => {
    registry.reset({
      bucketNames: ['test-bucket'],
      nextQuery: {pageToken: 'next-page-token'},
    });
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'test-project', page_size: 1, page_token: 'token'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
      next_page_token: 'next-page-token',
    });
    expect(registry.only().callArgs('getBuckets')).toEqual([
      {maxResults: 1, pageToken: 'token', autoPaginate: false},
    ]);
  });

  it('test_create_bucket', async () => {
    registry.reset({createdBucketName: 'test-bucket'});
    const tool = await getTool(readWriteToolset(), 'gcs_create_bucket');

    const result = await tool.runAsync({
      args: {project_id: 'test-project', bucket_name: 'test-bucket'},
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket created successfully.',
    });
    // adk-python passes `location=None`; the option is absent here instead.
    expect(registry.only().callArgs('createBucket')).toEqual([
      'test-bucket',
      {},
    ]);
  });

  it('test_update_bucket', async () => {
    const tool = await getTool(readWriteToolset(), 'gcs_update_bucket');

    const result = await tool.runAsync({
      args: {
        bucket_name: 'test-bucket',
        versioning_enabled: true,
        uniform_bucket_level_access_enabled: true,
      },
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket updated successfully.',
    });
    const storage = registry.only();
    expect(storage.callArgs('bucket.setMetadata')).toEqual([
      'test-bucket',
      {
        versioning: {enabled: true},
        iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
      },
    ]);
  });

  it('test_delete_bucket', async () => {
    const tool = await getTool(readWriteToolset(), 'gcs_delete_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket deleted successfully.',
    });
    expect(registry.only().callArgs('bucket.delete')).toEqual(['test-bucket']);
  });

  it('test_get_bucket', async () => {
    const metadata = {
      bucket_id: 'test-bucket-id',
      bucket_name: 'test-bucket',
      location: 'US',
      storage_class: 'STANDARD',
      time_created: '2024-01-01',
      updated: '2024-01-02',
      labels: {env: 'test'},
    };
    registry.reset({metadata});
    const tool = await getTool(readWriteToolset(), 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: metadata});
  });

  it('test_get_bucket_with_properties', async () => {
    const metadata = {
      kind: 'storage#bucket',
      id: 'test-bucket-id',
      name: 'test-bucket',
      location: 'US',
      storageClass: 'STANDARD',
      timeCreated: '2024-01-01',
      updated: '2024-01-02',
      labels: {env: 'test'},
      locationType: 'region',
      etag: 'etag-val',
      metageneration: 2,
      versioning: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
    };
    registry.reset({metadata});
    const tool = await getTool(readWriteToolset(), 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: createToolContext(),
    });

    // The raw API metadata is returned unchanged, as Python returns the
    // bucket's `_properties` copy.
    expect(result).toEqual({status: 'SUCCESS', results: metadata});
  });
});
