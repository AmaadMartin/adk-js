/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/integrations/gcs/test_gcs_toolset.py`, the two admin cases.
 *
 * adk-python asserts unprefixed names, because it prefixes later in
 * `get_tools_with_prefix`. adk-js prefixes inside `getTools`, so the ported
 * assertions name the prefixed tools. The test still pins what the toolset
 * exposes to the model, which is the behaviour the reference is checking.
 *
 * The reference also asserts `isinstance(tool, GoogleTool)`. `guidelines_js`
 * forbids `instanceof` for type detection, and adk-js ships no `isGoogleTool`
 * guard, so this port asserts `isFunctionTool`, which `GoogleTool` satisfies.
 * `admin_toolset_adk_js_test.ts` pins the credential wrapping directly.
 */

import {
  GcsAdminToolset,
  GcsCapability,
  GcsCredentialsConfig,
  isFunctionTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const credentialsConfig = new GcsCredentialsConfig({
  clientId: 'abc',
  clientSecret: 'def',
});

describe('GcsAdminToolset', () => {
  it('test_gcs_admin_toolset_tools_default', async () => {
    const toolset = new GcsAdminToolset({credentialsConfig});

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(['gcs_get_bucket', 'gcs_list_buckets']),
    );
  });

  it('test_gcs_admin_toolset_tools_read_write', async () => {
    const toolset = new GcsAdminToolset({
      credentialsConfig,
      gcsToolSettings: {capabilities: [GcsCapability.READ_WRITE]},
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
});
