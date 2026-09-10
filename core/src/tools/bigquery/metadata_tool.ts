/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The five BigQuery metadata tools.
 *
 * Ported from adk-python
 * `src/google/adk/integrations/bigquery/metadata_tool.py` (branch `main`).
 * Argument names stay `snake_case`: the model produces them, so they cross
 * the language boundary and must match adk-python.
 */

import type {
  DatasetResource,
  JobMetadata,
  TableMetadata,
} from '@google-cloud/bigquery';
import {z} from 'zod';

import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigQueryToolDeps, getToolClient} from './client.js';
import {BigQueryToolResult, runBigQueryTool} from './tool_result.js';

/** Arguments of {@link listDatasetIds}. */
export const LIST_DATASET_IDS_PARAMETERS = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
});

/** Arguments of {@link getDatasetInfo} and {@link listTableIds}. */
export const DATASET_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z.string().describe('The BigQuery dataset id.'),
});

/** Arguments of {@link getTableInfo}. */
export const GET_TABLE_INFO_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z
    .string()
    .describe('The BigQuery dataset id containing the table.'),
  table_id: z.string().describe('The BigQuery table id.'),
});

/** Arguments of {@link getJobInfo}. */
export const GET_JOB_INFO_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the job.'),
  job_id: z.string().describe('The BigQuery job id.'),
});

/**
 * Lists the BigQuery dataset ids of a project.
 *
 * @param input The project to list.
 * @param deps The clients and settings of the owning toolset.
 * @return The dataset ids, or the failure envelope.
 */
export async function listDatasetIds(
  input: z.infer<typeof LIST_DATASET_IDS_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<string[]>> {
  return runBigQueryTool(async () => {
    const client = await getToolClient(
      deps,
      input.project_id,
      'list_dataset_ids',
    );
    const [datasets] = await client.getDatasets({projectId: input.project_id});
    return datasets.flatMap((dataset) => (dataset.id ? [dataset.id] : []));
  });
}

/**
 * Reads the metadata of a BigQuery dataset.
 *
 * @param input The dataset to describe.
 * @param deps The clients and settings of the owning toolset.
 * @return The `bigquery#dataset` resource, or the failure envelope.
 */
export async function getDatasetInfo(
  input: z.infer<typeof DATASET_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<DatasetResource>> {
  return runBigQueryTool(async () => {
    const client = await getToolClient(
      deps,
      input.project_id,
      'get_dataset_info',
    );
    const dataset = client.dataset(input.dataset_id, {
      projectId: input.project_id,
    });
    // `getMetadata()` resolves `[any, Response]`, so the target carries the
    // type the BigQuery REST API actually returns.
    const [metadata]: [DatasetResource, unknown] = await dataset.getMetadata();
    return metadata;
  });
}

/**
 * Lists the table ids of a BigQuery dataset.
 *
 * @param input The dataset to list.
 * @param deps The clients and settings of the owning toolset.
 * @return The table ids, or the failure envelope.
 */
export async function listTableIds(
  input: z.infer<typeof DATASET_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<string[]>> {
  return runBigQueryTool(async () => {
    const client = await getToolClient(
      deps,
      input.project_id,
      'list_table_ids',
    );
    const [tables] = await client
      .dataset(input.dataset_id, {projectId: input.project_id})
      .getTables();
    return tables.flatMap((table) => (table.id ? [table.id] : []));
  });
}

/**
 * Reads the metadata of a BigQuery table.
 *
 * @param input The table to describe.
 * @param deps The clients and settings of the owning toolset.
 * @return The `bigquery#table` resource, or the failure envelope.
 */
export async function getTableInfo(
  input: z.infer<typeof GET_TABLE_INFO_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<TableMetadata>> {
  return runBigQueryTool(async () => {
    const client = await getToolClient(
      deps,
      input.project_id,
      'get_table_info',
    );
    const table = client
      .dataset(input.dataset_id, {projectId: input.project_id})
      .table(input.table_id);
    const [metadata]: [TableMetadata, unknown] = await table.getMetadata();
    return metadata;
  });
}

/**
 * Reads the metadata of a BigQuery job: its configuration, its statistics,
 * its status and the query it ran.
 *
 * @param input The job to describe.
 * @param deps The clients and settings of the owning toolset.
 * @return The `bigquery#job` resource, or the failure envelope.
 */
export async function getJobInfo(
  input: z.infer<typeof GET_JOB_INFO_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<JobMetadata>> {
  return runBigQueryTool(async () => {
    const client = await getToolClient(deps, input.project_id, 'get_job_info');
    const [metadata]: [JobMetadata, unknown] = await client
      .job(input.job_id)
      .getMetadata();
    return metadata;
  });
}

/**
 * Builds the five BigQuery metadata tools.
 *
 * @param deps The clients and settings of the owning toolset.
 * @return The tools, in adk-python's declaration order.
 */
export function createMetadataTools(deps: BigQueryToolDeps): BaseTool[] {
  return [
    new FunctionTool({
      name: 'list_dataset_ids',
      description: 'List BigQuery dataset ids in a Google Cloud project.',
      parameters: LIST_DATASET_IDS_PARAMETERS,
      execute: (input) => listDatasetIds(input, deps),
    }),
    new FunctionTool({
      name: 'get_dataset_info',
      description: 'Get metadata information about a BigQuery dataset.',
      parameters: DATASET_PARAMETERS,
      execute: (input) => getDatasetInfo(input, deps),
    }),
    new FunctionTool({
      name: 'list_table_ids',
      description: 'List table ids in a BigQuery dataset.',
      parameters: DATASET_PARAMETERS,
      execute: (input) => listTableIds(input, deps),
    }),
    new FunctionTool({
      name: 'get_table_info',
      description: 'Get metadata information about a BigQuery table.',
      parameters: GET_TABLE_INFO_PARAMETERS,
      execute: (input) => getTableInfo(input, deps),
    }),
    new FunctionTool({
      name: 'get_job_info',
      description:
        'Get metadata information about a BigQuery job, including its slot ' +
        'usage, configuration, statistics, status and original query.',
      parameters: GET_JOB_INFO_PARAMETERS,
      execute: (input) => getJobInfo(input, deps),
    }),
  ];
}
