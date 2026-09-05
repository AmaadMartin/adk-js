/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives every tool the toolset exposes through its own declaration, the way
 * a model call reaches it. adk-python covers the same ground with
 * `test_bigquery_toolset.py` plus the per-tool suites under
 * `tests/unittests/integrations/bigquery/` (branch `main`).
 */

import {BigQueryToolset, WriteMode, type BaseTool} from '@google/adk';
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

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient} = await import('./bigquery_fakes.js');
  return {CatalogServiceClient: FakeCatalogServiceClient};
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {getAccessToken: async () => ({token: 'test-token'})};
    }
  },
}));

/** Every call a tool makes to the model-facing surface, with its arguments. */
const TOOL_CALLS: Array<{name: string; args: Record<string, unknown>}> = [
  {name: 'list_dataset_ids', args: {project_id: 'p'}},
  {name: 'get_dataset_info', args: {project_id: 'p', dataset_id: 'd'}},
  {name: 'list_table_ids', args: {project_id: 'p', dataset_id: 'd'}},
  {
    name: 'get_table_info',
    args: {project_id: 'p', dataset_id: 'd', table_id: 't'},
  },
  {name: 'get_job_info', args: {project_id: 'p', job_id: 'j'}},
  {name: 'execute_sql', args: {project_id: 'p', query: 'SELECT 1'}},
  {
    name: 'forecast',
    args: {
      project_id: 'p',
      history_data: 'd.t',
      timestamp_col: 'ts',
      data_col: 'value',
    },
  },
  {
    name: 'analyze_contribution',
    args: {
      project_id: 'p',
      input_data: 'd.t',
      contribution_metric: 'SUM(m)',
      dimension_id_cols: ['dim'],
      is_test_col: 'is_test',
    },
  },
  {
    name: 'detect_anomalies',
    args: {
      project_id: 'p',
      history_data: 'd.t',
      times_series_timestamp_col: 'ts',
      times_series_data_col: 'value',
    },
  },
  {
    name: 'ask_data_insights',
    args: {
      project_id: 'p',
      user_query_with_context: 'who spent the most?',
      table_references: [{projectId: 'p', datasetId: 'd', tableId: 't'}],
    },
  },
  {name: 'search_catalog', args: {prompt: 'sales', project_id: 'p'}},
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetBigQueryState();
  bigQueryState.datasetIds = ['d'];
  bigQueryState.tableIds = ['t'];
  bigQueryState.replies = [{statementType: 'SELECT', rows: []}];
  globalThis.fetch = async (): Promise<Response> =>
    new Response('{"systemMessage": {"Answer": "ok"}}\n', {status: 200});
  return () => {
    globalThis.fetch = originalFetch;
  };
});

/** Finds one tool of the toolset by name. */
async function toolNamed(
  toolset: BigQueryToolset,
  name: string,
): Promise<BaseTool> {
  const tool = (await toolset.getTools()).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) {
    return expect.fail(`the toolset exposed no ${name} tool`);
  }
  return tool;
}

describe('the tools a BigQueryToolset exposes', () => {
  it.each(TOOL_CALLS)(
    'declares $name with a parameter schema',
    async ({name}) => {
      const toolset = new BigQueryToolset();

      const tool = await toolNamed(toolset, name);
      const declaration = tool._getDeclaration();

      expect(declaration?.name).toBe(name);
      expect(declaration?.description).toBeTruthy();
      expect(declaration?.parameters?.properties).toBeDefined();
    },
  );

  it.each(TOOL_CALLS)(
    'runs $name through its declaration',
    async ({name, args}) => {
      // ALLOWED lets the BigQuery ML tools reach their queries without a gate
      // refusing them first.
      const toolset = new BigQueryToolset({
        bigqueryToolConfig: {writeMode: WriteMode.ALLOWED},
      });

      const tool = await toolNamed(toolset, name);
      const result = await tool.runAsync({
        args,
        toolContext: createToolContext(),
      });

      expect(result).toBeDefined();
      expect(result).not.toMatchObject({status: 'ERROR'});
    },
  );

  it('reports a schema violation as a tool error, not a silent pass', async () => {
    const toolset = new BigQueryToolset();
    const tool = await toolNamed(toolset, 'get_table_info');

    await expect(
      tool.runAsync({
        args: {project_id: 'p'},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow("Error in tool 'get_table_info'");
  });
});
