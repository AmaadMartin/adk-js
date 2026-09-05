/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_toolset.py`
 * (branch `main`).
 */

import {
  BigQueryToolset,
  createSession,
  executeSqlDescription,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  WriteMode,
  type BaseTool,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  bigQueryState,
  createToolContext,
  resetBigQueryState,
} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

/** The eleven tools adk-python's toolset exposes. */
const ALL_TOOL_NAMES = [
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
];

/** Builds a readonly context, for the predicate filter. */
function readonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 's1', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager(),
    }),
  );
}

/** The names of `tools`, sorted so the comparison ignores order. */
function names(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

beforeEach(() => {
  resetBigQueryState();
});

describe('BigQueryToolset', () => {
  it('test_bigquery_toolset_tools_default', async () => {
    const toolset = new BigQueryToolset();

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(11);
    expect(names(tools)).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it.each([
    {id: 'None', selectedTools: []},
    {
      id: 'dataset-metadata',
      selectedTools: ['list_dataset_ids', 'get_dataset_info'],
    },
    {id: 'table-metadata', selectedTools: ['list_table_ids', 'get_table_info']},
    {id: 'query', selectedTools: ['execute_sql']},
  ])('test_bigquery_toolset_tools_selective ($id)', async ({selectedTools}) => {
    const toolset = new BigQueryToolset({toolFilter: selectedTools});

    const tools = await toolset.getTools();

    // An empty filter selects everything, as adk-python's does.
    const expected =
      selectedTools.length === 0 ? ALL_TOOL_NAMES : selectedTools;
    expect(names(tools)).toEqual([...expected].sort());
  });

  it.each([
    {id: 'all-unknown', selectedTools: ['unknown'], returnedTools: []},
    {
      id: 'mixed-known-unknown',
      selectedTools: ['unknown', 'execute_sql'],
      returnedTools: ['execute_sql'],
    },
  ])(
    'test_bigquery_toolset_unknown_tool ($id)',
    async ({selectedTools, returnedTools}) => {
      const toolset = new BigQueryToolset({toolFilter: selectedTools});

      const tools = await toolset.getTools();

      expect(names(tools)).toEqual([...returnedTools].sort());
    },
  );

  it('applies a name filter with a context too', async () => {
    const toolset = new BigQueryToolset({toolFilter: ['execute_sql']});

    const tools = await toolset.getTools(readonlyContext());

    expect(names(tools)).toEqual(['execute_sql']);
  });

  it('applies a predicate filter', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const withContext = await toolset.getTools(readonlyContext());
    const withoutContext = await toolset.getTools();

    expect(names(withContext)).toEqual(['list_dataset_ids', 'list_table_ids']);
    // Without a context there is nothing to evaluate the predicate against,
    // so it excludes nothing.
    expect(withoutContext).toHaveLength(11);
  });

  it('test_get_execute_sql_blocked_mode_returns_the_read_only_tool', async () => {
    const toolset = new BigQueryToolset({
      bigqueryToolConfig: {writeMode: WriteMode.BLOCKED},
    });

    const [tool] = await toolset.getTools();
    const executeSql = (await toolset.getTools()).find(
      (candidate) => candidate.name === 'execute_sql',
    );

    expect(tool).toBeDefined();
    expect(executeSql?.description).toBe(
      executeSqlDescription(WriteMode.BLOCKED),
    );
    expect(executeSql?.description).toContain(
      'Only a SELECT statement is accepted.',
    );
  });

  it('test_get_execute_sql_write_modes_get_distinct_docstrings', async () => {
    const descriptions = await Promise.all(
      [WriteMode.BLOCKED, WriteMode.PROTECTED, WriteMode.ALLOWED].map(
        async (writeMode) => {
          const toolset = new BigQueryToolset({
            bigqueryToolConfig: {writeMode},
          });
          const tools = await toolset.getTools();
          return tools.find((tool) => tool.name === 'execute_sql')?.description;
        },
      ),
    );

    expect(new Set(descriptions).size).toBe(3);
  });

  it('test_get_tools_binds_distinct_settings_per_toolset', async () => {
    const readOnly = new BigQueryToolset();
    const writable = new BigQueryToolset({
      bigqueryToolConfig: {writeMode: WriteMode.ALLOWED},
    });

    const readOnlyTool = (await readOnly.getTools()).find(
      (tool) => tool.name === 'execute_sql',
    );
    const writableTool = (await writable.getTools()).find(
      (tool) => tool.name === 'execute_sql',
    );

    expect(readOnlyTool?.description).not.toBe(writableTool?.description);
  });

  it('does not change the config it was given', () => {
    const bigqueryToolConfig = {jobLabels: {team: 'data'}};

    new BigQueryToolset({bigqueryToolConfig});

    expect(bigqueryToolConfig).toEqual({jobLabels: {team: 'data'}});
  });

  it('rejects an out-of-range configuration at construction', () => {
    expect(
      () =>
        new BigQueryToolset({
          bigqueryToolConfig: {maximumBytesBilled: 1},
        }),
    ).toThrow('max_bytes_billed must be set >=10485760');
  });

  it('opens no client until a tool runs', async () => {
    const toolset = new BigQueryToolset();
    await toolset.getTools();

    expect(bigQueryState.clientOptions).toHaveLength(0);
  });

  it('releases its clients on close', async () => {
    bigQueryState.datasetIds = ['dataset1'];
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const listDatasetIds = tools.find(
      (tool) => tool.name === 'list_dataset_ids',
    );
    if (!listDatasetIds) {
      return expect.fail('the toolset exposed no list_dataset_ids tool');
    }

    await listDatasetIds.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext(),
    });
    expect(bigQueryState.clientOptions).toHaveLength(1);

    await toolset.close();
    await listDatasetIds.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext(),
    });

    expect(bigQueryState.clientOptions).toHaveLength(2);
  });

  it('runs a tool end to end through its declaration', async () => {
    bigQueryState.datasetIds = ['dataset1', 'dataset2'];
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const listDatasetIds = tools.find(
      (tool) => tool.name === 'list_dataset_ids',
    );
    if (!listDatasetIds) {
      return expect.fail('the toolset exposed no list_dataset_ids tool');
    }

    const declaration = listDatasetIds._getDeclaration();
    const result = await listDatasetIds.runAsync({
      args: {project_id: 'test-project'},
      toolContext: createToolContext(),
    });

    expect(declaration?.parameters?.properties).toHaveProperty('project_id');
    expect(result).toEqual(['dataset1', 'dataset2']);
  });
});
