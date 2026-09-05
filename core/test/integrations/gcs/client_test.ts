/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `tests/unittests/integrations/gcs/test_client.py`,
 * read at `main` commit `a119dd77`. Each test keeps its reference name.
 *
 * adk-python calls `client.get_gcs_client` directly. adk-js builds the client
 * inside the tool call, so each test drives a tool and asserts on the clients
 * the double recorded.
 */

import {version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ADC_CREDENTIALS,
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

/** A session state holding the authorized user `refreshToken` belongs to. */
function stateFor(refreshToken: string): Record<string, unknown> {
  return {
    gcs_token_cache: {
      clientId: 'abc',
      clientSecret: 'def',
      refreshToken,
      accessToken: `access-for-${refreshToken}`,
    },
  };
}

/** The refresh token a recorded client was built with. */
function refreshTokenOf(options: Record<string, unknown>): unknown {
  const credentials = options['credentials'];
  return credentials !== null && typeof credentials === 'object'
    ? (credentials as Record<string, unknown>)['refresh_token']
    : undefined;
}

describe('the Cloud Storage client', () => {
  beforeEach(() => {
    registry.reset({bucketNames: []});
  });

  it('test_get_gcs_client', async () => {
    const toolset = createToolset({credentialsConfig: ADC_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_list_buckets');

    await tool.runAsync({
      args: {project_id: 'test-project'},
      toolContext: createToolContext(),
    });

    const {options} = registry.only();
    expect(options['projectId']).toBe('test-project');
    expect(options['userAgent']).toBe(`adk-gcs-tool google-adk/${version}`);
    // Application Default Credentials: storage reads the identity itself, so
    // the options name no credential.
    expect(options['credentials']).toBeUndefined();
  });

  it('test_get_gcs_client_is_never_shared_between_credentials', async () => {
    const toolset = createToolset({credentialsConfig: TEST_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');

    for (let i = 0; i < 200; i++) {
      await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext: createToolContext({state: stateFor(`token-${i}`)}),
      });
    }

    expect(registry.built).toHaveLength(200);
    registry.built.forEach((storage, i) => {
      expect(refreshTokenOf(storage.options)).toBe(`token-${i}`);
    });
  });

  it('test_get_gcs_client_returns_a_new_client_per_call', async () => {
    const toolset = createToolset({credentialsConfig: ADC_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_list_buckets');
    const context = createToolContext();

    await tool.runAsync({
      args: {project_id: 'test-project'},
      toolContext: context,
    });
    await tool.runAsync({
      args: {project_id: 'test-project'},
      toolContext: context,
    });

    expect(registry.built).toHaveLength(2);
    expect(registry.built[0]).not.toBe(registry.built[1]);
  });
});
