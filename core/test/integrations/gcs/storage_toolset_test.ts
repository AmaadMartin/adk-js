/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_gcs_toolset.py` and
 * `tests/unittests/integrations/gcs/test_gcs_storage_toolset.py`, at upstream
 * `main`.
 *
 * The reference asserts unprefixed tool names and reads the prefix from
 * `toolset.tool_name_prefix`, because adk-python's framework applies the
 * prefix later. adk-js applies it in `getToolsWithPrefix()`, so the
 * assertions below read the names through that method and expect the
 * prefixed name.
 */

import {
  DEFAULT_GCS_TOOL_NAME_PREFIX,
  GcsCapability,
  GcsToolset,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const READ_TOOL_NAMES = [
  'gcs_get_object_data',
  'gcs_get_object_metadata',
  'gcs_list_objects',
];

const ALL_TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  'gcs_create_object',
  'gcs_delete_objects',
];

async function toolNames(toolset: GcsToolset): Promise<string[]> {
  const tools = await toolset.getToolsWithPrefix();
  return tools.map((tool) => tool.name).sort();
}

describe('test_gcs_toolset.py', () => {
  it('test_gcs_toolset_tools_default', async () => {
    const toolset = new GcsToolset();

    expect(await toolNames(toolset)).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('test_gcs_toolset_tools_read_write', async () => {
    const toolset = new GcsToolset({
      capability: GcsCapability.READ_WRITE,
    });

    expect(await toolNames(toolset)).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it.each([
    {id: 'None', selectedTools: undefined, expected: READ_TOOL_NAMES},
    {
      id: 'read-subset',
      selectedTools: ['gcs_get_object_data', 'gcs_list_objects'],
      expected: ['gcs_get_object_data', 'gcs_list_objects'],
    },
  ])(
    'test_gcs_toolset_tools_selective [$id]',
    async ({selectedTools, expected}) => {
      const toolset = new GcsToolset({toolFilter: selectedTools});

      expect(await toolNames(toolset)).toEqual([...expected].sort());
    },
  );
});

describe('test_gcs_storage_toolset.py', () => {
  it('test_gcs_toolset_name_prefix', () => {
    const toolset = new GcsToolset();

    expect(toolset.prefix).toBe(DEFAULT_GCS_TOOL_NAME_PREFIX);
    expect(DEFAULT_GCS_TOOL_NAME_PREFIX).toBe('gcs');
  });

  it('test_gcs_toolset_tools_default', async () => {
    const toolset = new GcsToolset();

    expect(await toolNames(toolset)).toEqual([...READ_TOOL_NAMES].sort());
  });

  it.each([
    {id: 'None', selectedTools: undefined, expected: READ_TOOL_NAMES},
    {
      id: 'object-data-get',
      selectedTools: ['gcs_get_object_data'],
      expected: ['gcs_get_object_data'],
    },
    {
      id: 'object-metadata',
      selectedTools: ['gcs_list_objects', 'gcs_get_object_metadata'],
      expected: ['gcs_list_objects', 'gcs_get_object_metadata'],
    },
  ])(
    'test_gcs_toolset_tools_selective [$id]',
    async ({selectedTools, expected}) => {
      const toolset = new GcsToolset({toolFilter: selectedTools});

      expect(await toolNames(toolset)).toEqual([...expected].sort());
    },
  );
});
