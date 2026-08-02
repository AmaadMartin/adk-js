/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  GCS_TOOL_NAME_PREFIX,
  GcsToolset,
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
  gcs_get_bucket: {declared: ['bucket_name'], required: ['bucket_name']},
  gcs_get_object_data: {
    declared: [
      'bucket_name',
      'object_name',
      'generation',
      'destination_file_path',
    ],
    required: ['bucket_name', 'object_name'],
  },
  gcs_get_object_metadata: {
    declared: ['bucket_name', 'object_name', 'generation'],
    required: ['bucket_name', 'object_name'],
  },
  gcs_list_objects: {
    declared: ['bucket_name', 'prefix', 'page_size', 'page_token'],
    required: ['bucket_name'],
  },
  gcs_create_object: {
    declared: ['bucket_name', 'object_name', 'data', 'source_file_path'],
    required: ['bucket_name', 'object_name'],
  },
  gcs_delete_objects: {
    declared: ['bucket_name', 'object_names'],
    required: ['bucket_name', 'object_names'],
  },
};

describe('GcsToolset', () => {
  it('prefixes tool names with the GCS prefix', async () => {
    const toolset = new GcsToolset();
    expect(toolset.prefix).toBe(GCS_TOOL_NAME_PREFIX);

    const names = await toolNames(toolset);
    expect(
      names.every((name) => name.startsWith(`${GCS_TOOL_NAME_PREFIX}_`)),
    ).toBe(true);
  });

  it('exposes only the read tools by default', async () => {
    expect(await toolNames(new GcsToolset())).toEqual(
      [...STORAGE_READ_TOOL_NAMES].sort(),
    );
  });

  it('exposes only the read tools with the read-only capability', async () => {
    const toolset = new GcsToolset({toolSettings: READ_ONLY});
    expect(await toolNames(toolset)).toEqual(
      [...STORAGE_READ_TOOL_NAMES].sort(),
    );
  });

  it('adds the write tools with the read-write capability', async () => {
    const toolset = new GcsToolset({toolSettings: READ_WRITE});
    expect(await toolNames(toolset)).toEqual(
      [...STORAGE_READ_TOOL_NAMES, ...STORAGE_WRITE_TOOL_NAMES].sort(),
    );
  });

  it('exposes no tools without any capability', async () => {
    const toolset = new GcsToolset({toolSettings: NO_CAPABILITIES});
    expect(await toolset.getTools()).toEqual([]);
  });

  it('never exposes a bucket-level tool', async () => {
    for (const toolSettings of [READ_ONLY, READ_WRITE, NO_CAPABILITIES]) {
      const names = await toolNames(new GcsToolset({toolSettings}));
      for (const adminTool of [
        ...ADMIN_READ_TOOL_NAMES,
        ...ADMIN_WRITE_TOOL_NAMES,
      ]) {
        expect(names).not.toContain(adminTool);
      }
    }
  });

  it('returns function tools', async () => {
    const tools = await new GcsToolset({toolSettings: READ_WRITE}).getTools();
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('declares the adk-python parameter names to the model', async () => {
    const tools = await new GcsToolset({toolSettings: READ_WRITE}).getTools();
    expectParameters(tools, EXPECTED_PARAMETERS);
  });

  it('applies an array tool filter to the prefixed names', async () => {
    const one = new GcsToolset({toolFilter: ['gcs_get_bucket']});
    expect(await toolNames(one)).toEqual(['gcs_get_bucket']);

    const two = new GcsToolset({
      toolFilter: ['gcs_list_objects', 'gcs_get_object_metadata'],
    });
    expect(await toolNames(two)).toEqual([
      'gcs_get_object_metadata',
      'gcs_list_objects',
    ]);
  });

  it('applies a predicate tool filter when a context is supplied', async () => {
    const toolset = new GcsToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_list_objects',
    });

    expect(await toolNames(toolset, await createToolContext())).toEqual([
      'gcs_list_objects',
    ]);
  });

  it('keeps every tool when a predicate filter has no context', async () => {
    const toolset = new GcsToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_list_objects',
    });

    expect(await toolNames(toolset)).toEqual(
      [...STORAGE_READ_TOOL_NAMES].sort(),
    );
  });

  it('closes without error', async () => {
    await expect(new GcsToolset().close()).resolves.toBeUndefined();
  });
});
