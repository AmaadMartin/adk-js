/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  GCS_TOOL_NAME_PREFIX,
  GcsAdminToolset,
  isFunctionTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  ADMIN_READ_TOOL_NAMES,
  ADMIN_WRITE_TOOL_NAMES,
  createToolContext,
  expectParameters,
  NO_CAPABILITIES,
  READ_ONLY,
  READ_WRITE,
  STORAGE_READ_TOOL_NAMES,
  STORAGE_WRITE_TOOL_NAMES,
  toolNames,
} from './test_utils.js';

/** The parameter contract the model sees, mirroring adk-python. */
const EXPECTED_PARAMETERS = {
  gcs_list_buckets: {
    declared: ['project_id', 'page_size', 'page_token'],
    required: ['project_id'],
  },
  gcs_create_bucket: {
    declared: ['project_id', 'bucket_name', 'location'],
    required: ['project_id', 'bucket_name'],
  },
  gcs_update_bucket: {
    declared: [
      'bucket_name',
      'versioning_enabled',
      'uniform_bucket_level_access_enabled',
    ],
    required: ['bucket_name'],
  },
  gcs_delete_bucket: {declared: ['bucket_name'], required: ['bucket_name']},
};

describe('GcsAdminToolset', () => {
  it('prefixes tool names with the GCS prefix', async () => {
    const toolset = new GcsAdminToolset();
    expect(toolset.prefix).toBe(GCS_TOOL_NAME_PREFIX);

    const names = await toolNames(toolset);
    expect(
      names.every((name) => name.startsWith(`${GCS_TOOL_NAME_PREFIX}_`)),
    ).toBe(true);
  });

  it('exposes only list_buckets by default', async () => {
    expect(await toolNames(new GcsAdminToolset())).toEqual(
      ADMIN_READ_TOOL_NAMES,
    );
  });

  it('exposes only list_buckets with the read-only capability', async () => {
    const toolset = new GcsAdminToolset({toolSettings: READ_ONLY});
    expect(await toolNames(toolset)).toEqual(ADMIN_READ_TOOL_NAMES);
  });

  it('adds the bucket mutation tools with the read-write capability', async () => {
    const toolset = new GcsAdminToolset({toolSettings: READ_WRITE});
    expect(await toolNames(toolset)).toEqual(
      [...ADMIN_READ_TOOL_NAMES, ...ADMIN_WRITE_TOOL_NAMES].sort(),
    );
  });

  it('exposes no tools without any capability', async () => {
    const toolset = new GcsAdminToolset({toolSettings: NO_CAPABILITIES});
    expect(await toolset.getTools()).toEqual([]);
  });

  it('never exposes an object-level tool', async () => {
    for (const toolSettings of [READ_ONLY, READ_WRITE, NO_CAPABILITIES]) {
      const names = await toolNames(new GcsAdminToolset({toolSettings}));
      for (const objectTool of [
        ...STORAGE_READ_TOOL_NAMES,
        ...STORAGE_WRITE_TOOL_NAMES,
      ]) {
        expect(names).not.toContain(objectTool);
      }
    }
  });

  it('returns function tools', async () => {
    const tools = await new GcsAdminToolset({
      toolSettings: READ_WRITE,
    }).getTools();
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('declares the adk-python parameter names to the model', async () => {
    const tools = await new GcsAdminToolset({
      toolSettings: READ_WRITE,
    }).getTools();
    expectParameters(tools, EXPECTED_PARAMETERS);
  });

  it('applies an array tool filter to the prefixed names', async () => {
    const toolset = new GcsAdminToolset({
      toolFilter: ['gcs_delete_bucket'],
      toolSettings: READ_WRITE,
    });
    expect(await toolNames(toolset)).toEqual(['gcs_delete_bucket']);
  });

  it('applies a predicate tool filter when a context is supplied', async () => {
    const toolset = new GcsAdminToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_create_bucket',
      toolSettings: READ_WRITE,
    });

    expect(await toolNames(toolset, await createToolContext())).toEqual([
      'gcs_create_bucket',
    ]);
  });

  it('closes without error', async () => {
    await expect(new GcsAdminToolset().close()).resolves.toBeUndefined();
  });
});
