/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  DEFAULT_GCS_TOOL_NAME_PREFIX,
  GCSAdminToolset,
  GCSCapability,
  GCSToolset,
  isFunctionTool,
  ReadonlyContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createToolContext} from './gcs_test_utils.js';

const READ_TOOL_NAMES = [
  'gcs_get_bucket',
  'gcs_get_object_data',
  'gcs_get_object_metadata',
  'gcs_list_objects',
];
const WRITE_TOOL_NAMES = ['gcs_create_object', 'gcs_delete_objects'];
const ADMIN_READ_TOOL_NAMES = ['gcs_list_buckets'];
const ADMIN_WRITE_TOOL_NAMES = [
  'gcs_create_bucket',
  'gcs_update_bucket',
  'gcs_delete_bucket',
];

const READ_WRITE = {capabilities: [GCSCapability.READ_WRITE]};
const READ_ONLY = {capabilities: [GCSCapability.READ_ONLY]};
const NO_CAPABILITIES = {capabilities: []};

/** The parameter contract the model sees, mirroring adk-python. */
const EXPECTED_PARAMETERS: Record<
  string,
  {declared: string[]; required: string[]}
> = {
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

async function toolNames(
  toolset: GCSToolset | GCSAdminToolset,
  context?: ReadonlyContext,
): Promise<string[]> {
  return (await toolset.getTools(context)).map((tool) => tool.name).sort();
}

describe('GCS tool declarations', () => {
  it('declare the adk-python parameter names to the model', async () => {
    const tools = [
      ...(await new GCSToolset({toolSettings: READ_WRITE}).getTools()),
      ...(await new GCSAdminToolset({toolSettings: READ_WRITE}).getTools()),
    ];
    expect(tools).toHaveLength(Object.keys(EXPECTED_PARAMETERS).length);

    for (const tool of tools) {
      const parameters = tool._getDeclaration()?.parameters;
      expect(Object.keys(parameters?.properties ?? {})).toEqual(
        EXPECTED_PARAMETERS[tool.name].declared,
      );
      expect(parameters?.required ?? []).toEqual(
        EXPECTED_PARAMETERS[tool.name].required,
      );
    }
  });
});

describe('GCSToolset', () => {
  it('prefixes tool names with the GCS prefix', async () => {
    expect(new GCSToolset().prefix).toBe(DEFAULT_GCS_TOOL_NAME_PREFIX);
    expect(new GCSAdminToolset().prefix).toBe(DEFAULT_GCS_TOOL_NAME_PREFIX);

    const names = await toolNames(new GCSToolset());
    expect(
      names.every((name) =>
        name.startsWith(`${DEFAULT_GCS_TOOL_NAME_PREFIX}_`),
      ),
    ).toBe(true);
  });

  it('exposes only the read tools by default', async () => {
    expect(await toolNames(new GCSToolset())).toEqual(
      [...READ_TOOL_NAMES].sort(),
    );
  });

  it('exposes only the read tools with the read-only capability', async () => {
    const toolset = new GCSToolset({toolSettings: READ_ONLY});
    expect(await toolNames(toolset)).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('adds the write tools with the read-write capability', async () => {
    const toolset = new GCSToolset({toolSettings: READ_WRITE});
    expect(await toolNames(toolset)).toEqual(
      [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort(),
    );
  });

  it('exposes no tools without any capability', async () => {
    const toolset = new GCSToolset({toolSettings: NO_CAPABILITIES});
    expect(await toolset.getTools()).toEqual([]);
  });

  it('never exposes a bucket-level tool', async () => {
    for (const toolSettings of [READ_ONLY, READ_WRITE, NO_CAPABILITIES]) {
      const names = await toolNames(new GCSToolset({toolSettings}));
      for (const adminTool of [
        ...ADMIN_READ_TOOL_NAMES,
        ...ADMIN_WRITE_TOOL_NAMES,
      ]) {
        expect(names).not.toContain(adminTool);
      }
    }
  });

  it('returns function tools', async () => {
    const tools = await new GCSToolset({toolSettings: READ_WRITE}).getTools();
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('applies an array tool filter to the prefixed names', async () => {
    const one = new GCSToolset({toolFilter: ['gcs_get_bucket']});
    expect(await toolNames(one)).toEqual(['gcs_get_bucket']);

    const two = new GCSToolset({
      toolFilter: ['gcs_list_objects', 'gcs_get_object_metadata'],
    });
    expect(await toolNames(two)).toEqual([
      'gcs_get_object_metadata',
      'gcs_list_objects',
    ]);
  });

  it('applies a predicate tool filter when a context is supplied', async () => {
    const toolset = new GCSToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_list_objects',
    });

    expect(await toolNames(toolset, await createToolContext())).toEqual([
      'gcs_list_objects',
    ]);
  });

  it('keeps every tool when a predicate filter has no context', async () => {
    const toolset = new GCSToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_list_objects',
    });

    expect(await toolNames(toolset)).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('closes without error', async () => {
    await expect(new GCSToolset().close()).resolves.toBeUndefined();
  });
});

describe('GCSAdminToolset', () => {
  it('exposes only list_buckets by default', async () => {
    expect(await toolNames(new GCSAdminToolset())).toEqual(
      ADMIN_READ_TOOL_NAMES,
    );
  });

  it('adds the bucket mutation tools with the read-write capability', async () => {
    const toolset = new GCSAdminToolset({toolSettings: READ_WRITE});
    expect(await toolNames(toolset)).toEqual(
      [...ADMIN_READ_TOOL_NAMES, ...ADMIN_WRITE_TOOL_NAMES].sort(),
    );
  });

  it('exposes no tools without any capability', async () => {
    const toolset = new GCSAdminToolset({toolSettings: NO_CAPABILITIES});
    expect(await toolset.getTools()).toEqual([]);
  });

  it('never exposes an object-level tool', async () => {
    for (const toolSettings of [READ_ONLY, READ_WRITE, NO_CAPABILITIES]) {
      const names = await toolNames(new GCSAdminToolset({toolSettings}));
      for (const objectTool of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
        expect(names).not.toContain(objectTool);
      }
    }
  });

  it('returns function tools', async () => {
    const tools = await new GCSAdminToolset({
      toolSettings: READ_WRITE,
    }).getTools();
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('applies an array tool filter to the prefixed names', async () => {
    const toolset = new GCSAdminToolset({
      toolFilter: ['gcs_delete_bucket'],
      toolSettings: READ_WRITE,
    });
    expect(await toolNames(toolset)).toEqual(['gcs_delete_bucket']);
  });

  it('applies a predicate tool filter when a context is supplied', async () => {
    const toolset = new GCSAdminToolset({
      toolFilter: (tool: BaseTool) => tool.name === 'gcs_create_bucket',
      toolSettings: READ_WRITE,
    });

    expect(await toolNames(toolset, await createToolContext())).toEqual([
      'gcs_create_bucket',
    ]);
  });

  it('closes without error', async () => {
    await expect(new GCSAdminToolset().close()).resolves.toBeUndefined();
  });
});
