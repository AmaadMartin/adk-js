/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `GcsAdminToolset` that the adk-python suite does not cover:
 * the capability gate at its edges, the tool filter, and `close`.
 */

import {
  FeatureName,
  GcsCapabilities,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';
import {createReadonlyContext, createToolset} from './gcs_test_utils.js';

/** The names a toolset exposes, in the order it builds them. */
async function toolNames(
  ...args: Parameters<typeof createToolset>
): Promise<string[]> {
  const tools = await createToolset(...args).getTools();
  return tools.map((tool) => tool.name);
}

describe('GcsAdminToolset capability gate', () => {
  it('exposes no tool when the capabilities are empty', async () => {
    expect(await toolNames({gcsToolSettings: {capabilities: []}})).toEqual([]);
  });

  it('exposes the read tools under READ_ONLY', async () => {
    expect(
      await toolNames({
        gcsToolSettings: {capabilities: [GcsCapabilities.READ_ONLY]},
      }),
    ).toEqual(['gcs_get_bucket', 'gcs_list_buckets']);
  });

  it('exposes the write tools only under READ_WRITE', async () => {
    expect(
      await toolNames({
        gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
      }),
    ).toEqual([
      'gcs_get_bucket',
      'gcs_list_buckets',
      'gcs_create_bucket',
      'gcs_update_bucket',
      'gcs_delete_bucket',
    ]);
  });

  it('treats an undefined capabilities field as the read-only default', async () => {
    expect(
      await toolNames({gcsToolSettings: {capabilities: undefined}}),
    ).toEqual(['gcs_get_bucket', 'gcs_list_buckets']);
  });

  it('asks the user to confirm every tool that changes a bucket', async () => {
    const toolset = createToolset({
      gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
    });
    const tools = await toolset.getTools();

    const gated: string[] = [];
    for (const tool of tools) {
      if (await tool.checkRequireConfirmation({bucket_name: 'b'})) {
        gated.push(tool.name);
      }
    }

    expect(gated).toEqual([
      'gcs_create_bucket',
      'gcs_update_bucket',
      'gcs_delete_bucket',
    ]);
  });
});

describe('GcsAdminToolset tool filter', () => {
  it('selects by the prefixed name', async () => {
    expect(await toolNames({toolFilter: ['gcs_list_buckets']})).toEqual([
      'gcs_list_buckets',
    ]);
  });

  it('selects nothing for a bare adk-python name', async () => {
    // adk-python filters on `list_buckets`; adk-js bakes the prefix into the
    // tool name and filters on that.
    expect(await toolNames({toolFilter: ['list_buckets']})).toEqual([]);
  });

  it('treats an empty array as no filter', async () => {
    expect(await toolNames({toolFilter: []})).toEqual([
      'gcs_get_bucket',
      'gcs_list_buckets',
    ]);
  });

  it('applies a predicate when it is given a context', async () => {
    const toolset = createToolset({
      toolFilter: (tool) => tool.name === 'gcs_get_bucket',
    });

    const withContext = await toolset.getTools(createReadonlyContext());

    expect(withContext.map((tool) => tool.name)).toEqual(['gcs_get_bucket']);
  });

  it('cannot apply a predicate without a context, so exposes every tool', async () => {
    const toolset = createToolset({
      toolFilter: (tool) => tool.name === 'gcs_get_bucket',
    });

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'gcs_get_bucket',
      'gcs_list_buckets',
    ]);
  });
});

describe('GcsAdminToolset lifecycle', () => {
  it('closes without holding a resource', async () => {
    await expect(createToolset().close()).resolves.toBeUndefined();
  });
});

describe('the GCS_TOOL_SETTINGS feature', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, undefined);
  });

  it('refuses to build a toolset while it is disabled', () => {
    overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, false);

    expect(() => createToolset()).toThrow(
      'Feature GCS_TOOL_SETTINGS is not enabled.',
    );
  });
});
