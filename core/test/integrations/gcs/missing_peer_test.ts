/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a Cloud Storage tool answers when the optional peer dependency is not
 * installed. The mock stands in for an uninstalled package for the whole file,
 * so this cannot share one with the suites that drive a working client.
 *
 * `loadOptionalPeer`'s own message is pinned by
 * `core/test/utils/optional_peer_test.ts`. What matters here is that the
 * failure reaches the model as a result it can read, rather than rejecting.
 */

import {describe, expect, it, vi} from 'vitest';
import {
  ADC_CREDENTIALS,
  createToolContext,
  createToolset,
  getTool,
} from './gcs_test_utils.js';

vi.mock('@google-cloud/storage', () => {
  throw new Error("Cannot find package '@google-cloud/storage'");
});

describe('a missing @google-cloud/storage', () => {
  it('reaches the model as an ERROR result naming the package', async () => {
    const toolset = createToolset({credentialsConfig: ADC_CREDENTIALS});
    const tool = await getTool(toolset, 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'b'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toContain(
      '@google-cloud/storage',
    );
  });
});
