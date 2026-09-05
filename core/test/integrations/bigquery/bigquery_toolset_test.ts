/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_toolset.py`. The ported
 * cases keep their Python names, including the pytest parameter id, so the two
 * projects stay greppable against each other.
 *
 * Two assertions differ from the reference. Python reads
 * `toolset._tool_settings`; reaching into a private member is not allowed
 * here, so the case asserts the observable equivalent instead. Python also
 * asserts `isinstance(tool, GoogleTool)`; adk-js ships no `isGoogleTool`
 * guard and forbids `instanceof`, so the cases below assert the base guard,
 * and `bigquery_toolset_behaviour_test.ts` asserts the behaviour that makes a
 * tool a `GoogleTool`: it answers a failure instead of throwing.
 */

import {isFunctionTool} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolset,
  createBigQueryToolSettings,
} from '@google/adk/integrations/bigquery/index.js';
import {describe, expect, it} from 'vitest';

/** The credentials every ported case builds its toolset with. */
function credentialsConfig(): BigQueryCredentialsConfig {
  return new BigQueryCredentialsConfig({
    clientId: 'abc',
    clientSecret: 'def',
  });
}

describe('BigQueryToolset', () => {
  it('test_bigquery_toolset_tools_default', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: credentialsConfig(),
      bigqueryToolConfig: undefined,
    });
    // The observable stand-in for Python's `toolset._tool_settings` check: the
    // defaults the toolset applies are the defaults a fresh config produces.
    expect(createBigQueryToolSettings()).toEqual({
      writeMode: 'blocked',
      maxQueryResultRows: 50,
    });

    const tools = await toolset.getTools();
    expect(tools).toBeDefined();

    expect(tools).toHaveLength(11);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);

    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        'list_dataset_ids',
        'get_dataset_info',
        'list_table_ids',
        'get_table_info',
        'get_job_info',
        'execute_sql',
        'ask_data_insights',
        'forecast',
        'analyze_contribution',
        'detect_anomalies',
        'search_catalog',
      ]),
    );
  });

  it.each([
    {id: 'None', selectedTools: [] as string[]},
    {
      id: 'dataset-metadata',
      selectedTools: ['list_dataset_ids', 'get_dataset_info'],
    },
    {id: 'table-metadata', selectedTools: ['list_table_ids', 'get_table_info']},
    {id: 'query', selectedTools: ['execute_sql']},
  ])('test_bigquery_toolset_tools_selective[$id]', async ({selectedTools}) => {
    const toolset = new BigQueryToolset({
      credentialsConfig: credentialsConfig(),
      toolFilter: selectedTools,
    });
    const tools = await toolset.getTools();
    expect(tools).toBeDefined();

    expect(tools).toHaveLength(selectedTools.length);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);

    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(selectedTools),
    );
  });

  it.each([
    {
      id: 'all-unknown',
      selectedTools: ['unknown'],
      returnedTools: [] as string[],
    },
    {
      id: 'mixed-known-unknown',
      selectedTools: ['unknown', 'execute_sql'],
      returnedTools: ['execute_sql'],
    },
  ])(
    'test_bigquery_toolset_unknown_tool[$id]',
    async ({selectedTools, returnedTools}) => {
      const toolset = new BigQueryToolset({
        credentialsConfig: credentialsConfig(),
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();
      expect(tools).toBeDefined();

      expect(tools).toHaveLength(returnedTools.length);
      expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);

      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(returnedTools),
      );
    },
  );
});
