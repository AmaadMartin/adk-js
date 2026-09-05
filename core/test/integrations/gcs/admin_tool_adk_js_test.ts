/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The failure and edge paths of the Cloud Storage admin tools, which the
 * adk-python suite does not cover: a rejected API call, a pending
 * authorization, a missing peer dependency, and the two list and update cases
 * that make no remote call.
 */

import {GcsCapabilities} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ADC_CREDENTIALS,
  authorizedState,
  createConfirmedToolContext,
  createToolContext,
  createToolset,
  getTool,
  TEST_CREDENTIALS,
} from './gcs_test_utils.js';

const registry = await vi.hoisted(async () => {
  const {FakeStorageRegistry} = await import('./gcs_test_utils.js');
  return new FakeStorageRegistry();
});

vi.mock('@google-cloud/storage', () => ({Storage: registry.Storage}));

/** Every admin tool, with arguments that satisfy its schema. */
const EVERY_TOOL: ReadonlyArray<{name: string; args: Record<string, unknown>}> =
  [
    {name: 'gcs_get_bucket', args: {bucket_name: 'b'}},
    {name: 'gcs_list_buckets', args: {project_id: 'p'}},
    {name: 'gcs_create_bucket', args: {project_id: 'p', bucket_name: 'b'}},
    {
      name: 'gcs_update_bucket',
      args: {bucket_name: 'b', versioning_enabled: true},
    },
    {name: 'gcs_delete_bucket', args: {bucket_name: 'b'}},
  ];

/** A read-write toolset authenticating as the agent's own identity. */
function readWriteToolset() {
  return createToolset({
    credentialsConfig: ADC_CREDENTIALS,
    gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
  });
}

describe('a failing Cloud Storage call', () => {
  beforeEach(() => {
    registry.reset();
  });

  it.each(EVERY_TOOL)(
    'reaches the model as an ERROR result from $name',
    async ({name, args}) => {
      registry.reset({failWith: new Error('bucket is not accessible')});
      const tool = await getTool(readWriteToolset(), name);

      const result = await tool.runAsync({
        args,
        toolContext: createConfirmedToolContext(),
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'bucket is not accessible',
      });
    },
  );
});

describe('a call that is not yet authorized', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('answers with the authorization sentence and builds no client', async () => {
    const toolset = createToolset({credentialsConfig: TEST_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: createToolContext(),
    });

    expect(result).toBe(
      'User authorization is required to access Google services for' +
        ' gcs_get_bucket. Please complete the authorization flow.',
    );
    expect(registry.built).toHaveLength(0);
  });

  it('reuses the authorized user the session state already holds', async () => {
    registry.reset({metadata: {name: 'b'}});
    const toolset = createToolset({credentialsConfig: TEST_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: createToolContext({state: authorizedState()}),
    });

    expect(result).toEqual({status: 'SUCCESS', results: {name: 'b'}});
    expect(registry.only().options['credentials']).toEqual({
      type: 'authorized_user',
      client_id: 'abc',
      client_secret: 'def',
      refresh_token: 'refresh-token',
    });
  });
});

describe('gcs_list_buckets', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('omits next_page_token entirely when the page reports none', async () => {
    registry.reset({bucketNames: ['a'], nextQuery: null});
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'p', page_size: 10},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['a']});
    expect(result).not.toHaveProperty('next_page_token');
  });

  it('omits the page token from the query when the caller names none', async () => {
    registry.reset({bucketNames: []});
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    await tool.runAsync({
      args: {project_id: 'p', page_size: 5},
      toolContext: createToolContext(),
    });

    expect(registry.only().callArgs('getBuckets')).toEqual([
      {maxResults: 5, autoPaginate: false},
    ]);
  });

  it('omits an empty next page token', async () => {
    registry.reset({bucketNames: ['a'], nextQuery: {pageToken: ''}});
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'p', page_size: 10},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['a']});
  });

  it('lists every bucket without a query when no page size is given', async () => {
    registry.reset({bucketNames: ['a', 'b']});
    const tool = await getTool(readWriteToolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['a', 'b']});
    expect(registry.only().callArgs('getBuckets')).toEqual([]);
  });
});

describe('gcs_create_bucket', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('passes the location on when the caller names one', async () => {
    const tool = await getTool(readWriteToolset(), 'gcs_create_bucket');

    await tool.runAsync({
      args: {project_id: 'p', bucket_name: 'b', location: 'europe-west1'},
      toolContext: createConfirmedToolContext(),
    });

    expect(registry.only().callArgs('createBucket')).toEqual([
      'b',
      {location: 'europe-west1'},
    ]);
  });

  it('reports the name the API returned, not the one asked for', async () => {
    registry.reset({createdBucketName: 'b-renamed'});
    const tool = await getTool(readWriteToolset(), 'gcs_create_bucket');

    const result = await tool.runAsync({
      args: {project_id: 'p', bucket_name: 'b'},
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket b-renamed created successfully.',
    });
  });
});

describe('gcs_update_bucket', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('makes no remote call when neither setting is named', async () => {
    const tool = await getTool(readWriteToolset(), 'gcs_update_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket b updated successfully.',
    });
    expect(registry.only().callCount('bucket.setMetadata')).toBe(0);
  });

  it('patches only the setting the caller named', async () => {
    const tool = await getTool(readWriteToolset(), 'gcs_update_bucket');

    await tool.runAsync({
      args: {bucket_name: 'b', uniform_bucket_level_access_enabled: false},
      toolContext: createConfirmedToolContext(),
    });

    expect(registry.only().callArgs('bucket.setMetadata')).toEqual([
      'b',
      {iamConfiguration: {uniformBucketLevelAccess: {enabled: false}}},
    ]);
  });
});

describe('a completed authorization flow', () => {
  /**
   * The session state `Context.getAuthResponse` reads a finished flow from.
   * `AuthHandler` namespaces the credential key with `temp:`.
   */
  function completedFlowState(
    oauth2: Record<string, unknown>,
  ): Record<string, unknown> {
    return {'temp:gcs_token_cache': {authType: 'oauth2', oauth2}};
  }

  beforeEach(() => {
    registry.reset({metadata: {name: 'b'}});
  });

  it('caches the authorized user and authenticates the call with it', async () => {
    const toolset = createToolset({credentialsConfig: TEST_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');
    const context = createToolContext({
      state: completedFlowState({
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        expiresAt: 1893456000000,
      }),
    });

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: context,
    });

    expect(result).toEqual({status: 'SUCCESS', results: {name: 'b'}});
    expect(registry.only().options).toMatchObject({
      credentials: {
        type: 'authorized_user',
        client_id: 'abc',
        client_secret: 'def',
        refresh_token: 'fresh-refresh-token',
      },
      clientOptions: {
        credentials: {
          access_token: 'fresh-access-token',
          expiry_date: 1893456000000,
        },
      },
    });
    // The next call reads the cache rather than the flow.
    expect(context.state.get('gcs_token_cache')).toMatchObject({
      refreshToken: 'fresh-refresh-token',
    });
  });

  it('reports a flow that returned no refresh token as an ERROR result', async () => {
    const toolset = createToolset({credentialsConfig: TEST_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: createToolContext({
        state: completedFlowState({accessToken: 'access-only'}),
      }),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toContain(
      'no refresh token',
    );
    expect(registry.built).toHaveLength(0);
  });
});
