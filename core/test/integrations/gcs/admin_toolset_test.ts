/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_gcs_toolset.py` and
 * `test_gcs_storage_toolset.py`, read at `main` commit `a119dd77`. Each test
 * keeps its reference name.
 *
 * The cases exercising `GCSToolset` (object storage) are out of scope for this
 * change and are not ported.
 */

import {GcsCapabilities, isFunctionTool} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createToolset} from './gcs_test_utils.js';

describe('GcsAdminToolset', () => {
  it('test_gcs_admin_toolset_tools_default', async () => {
    // adk-python passes `gcs_tool_settings=None` explicitly, which must read
    // as "use the defaults".
    const toolset = createToolset({gcsToolSettings: undefined});

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(['gcs_get_bucket', 'gcs_list_buckets']),
    );
  });

  it('test_gcs_admin_toolset_tools_read_write', async () => {
    const toolset = createToolset({
      gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(5);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        'gcs_get_bucket',
        'gcs_list_buckets',
        'gcs_create_bucket',
        'gcs_update_bucket',
        'gcs_delete_bucket',
      ]),
    );
  });

  it('test_gcs_toolset_name_prefix', () => {
    // The admin half of the reference test; its GCSToolset half is out of
    // scope.
    expect(createToolset().prefix).toBe('gcs');
  });
});
