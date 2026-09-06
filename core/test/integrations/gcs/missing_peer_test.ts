/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a user sees when `@google-cloud/storage` cannot be resolved. The
 * optional peer is mocked as unresolvable for this whole file, so it must stay
 * separate from the files that mock a working client.
 *
 * Vitest reports a failing module factory through an error of its own and
 * drops the `code` that marks a missing package, so this file cannot assert
 * the install command `loadOptionalPeer` adds. That message is pinned by
 * `core/test/utils/optional_peer_test.ts`. What is pinned here belongs to the
 * toolset: it loads the package lazily, and it reports a load failure as a
 * value rather than throwing at the model.
 */

import {
  Context,
  createSession,
  DEFAULT_GCS_TOOL_NAME_PREFIX,
  GcsToolset,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@google-cloud/storage', () => {
  const err: Error & {code?: string} = new Error(
    "Cannot find package '@google-cloud/storage' imported from /app.js",
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return Promise.reject(err);
});

describe('GcsToolset without a resolvable @google-cloud/storage', () => {
  it('imports and lists its tools, because the package is loaded lazily', async () => {
    const toolset = new GcsToolset();

    expect(DEFAULT_GCS_TOOL_NAME_PREFIX).toBe('gcs');
    expect(
      (await toolset.getToolsWithPrefix()).map((tool) => tool.name),
    ).toEqual([
      'gcs_get_object_data',
      'gcs_get_object_metadata',
      'gcs_list_objects',
    ]);
  });

  it('reports the load failure as an error record instead of throwing', async () => {
    const tools = await new GcsToolset().getToolsWithPrefix();
    const listObjects = tools.find((tool) => tool.name === 'gcs_list_objects');
    if (!listObjects) {
      expect.fail('gcs_list_objects is missing');
    }

    const result = await listObjects.runAsync({
      args: {bucket_name: 'test-bucket'},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          session: createSession({id: 'session-1', appName: 'app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect(result).toHaveProperty(
      'error_details',
      expect.stringContaining('@google-cloud/storage'),
    );
  });
});
