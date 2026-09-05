/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the code samples in `docs/guides/tools/bigquery_toolset/index.md`, so
 * a sample cannot drift from the API it documents.
 */

import {BigQueryToolset, LlmAgent, WriteMode} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

describe('the BigQueryToolset guide samples', () => {
  it('builds the get-started agent', async () => {
    const rootAgent = new LlmAgent({
      name: 'bigquery_agent',
      model: 'gemini-2.5-flash',
      instruction:
        'Answer questions about BigQuery data. Use list_dataset_ids and ' +
        'list_table_ids to find the data, get_table_info to read a schema, ' +
        'and execute_sql to query it.',
      tools: [new BigQueryToolset()],
    });

    await expect(rootAgent.canonicalTools()).resolves.toHaveLength(11);
  });

  it('builds the metadata-only toolset', async () => {
    const metadataOnly = new BigQueryToolset({
      toolFilter: ['list_dataset_ids', 'get_dataset_info', 'list_table_ids'],
    });

    await expect(metadataOnly.getTools()).resolves.toHaveLength(3);
  });

  it('builds the configured toolset', async () => {
    const toolset = new BigQueryToolset({
      bigqueryToolConfig: {
        writeMode: WriteMode.PROTECTED,
        maxQueryResultRows: 200,
        maximumBytesBilled: 10_485_760,
        applicationName: 'my-agent',
        computeProjectId: 'my-compute-project',
        location: 'europe-west1',
        jobLabels: {team: 'data'},
      },
    });

    await expect(toolset.getTools()).resolves.toHaveLength(11);
  });

  it('builds the key-file toolset and releases it', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: {keyFilename: '/path/to/service-account.json'},
    });

    await expect(toolset.getTools()).resolves.toHaveLength(11);
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
