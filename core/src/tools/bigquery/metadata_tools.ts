/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {getBigQueryClient} from './client_helper.js';
import {BigQueryToolConfig} from './config.js';
import {BigQueryCredentialsConfig} from './credentials.js';

/**
 * List BigQuery dataset ids in a Google Cloud project.
 */
export async function listDatasetIds(
  args: {projectId: string},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<string[] | {status: string; error_details: string}> {
  try {
    const client = await getBigQueryClient(
      args.projectId,
      credentialsConfig,
      toolConfig,
      context,
    );
    const [datasets] = await client.getDatasets();
    // dataset.id is usually "project:dataset" or just "dataset" depending on how it was retrieved.
    // We want the datasetId.
    return datasets.map((d) => d.id!.split(':').pop()!);
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

/**
 * Get metadata information about a BigQuery dataset.
 */
export async function getDatasetInfo(
  args: {projectId: string; datasetId: string},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  try {
    const client = await getBigQueryClient(
      args.projectId,
      credentialsConfig,
      toolConfig,
      context,
    );
    const [, apiResponse] = await client.dataset(args.datasetId).get();
    return apiResponse;
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

/**
 * List table ids in a BigQuery dataset.
 */
export async function listTableIds(
  args: {projectId: string; datasetId: string},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<string[] | {status: string; error_details: string}> {
  try {
    const client = await getBigQueryClient(
      args.projectId,
      credentialsConfig,
      toolConfig,
      context,
    );
    const [tables] = await client.dataset(args.datasetId).getTables();
    return tables.map((t) => t.id!.split('.').pop()!);
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

/**
 * Get metadata information about a BigQuery table.
 */
export async function getTableInfo(
  args: {projectId: string; datasetId: string; tableId: string},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  try {
    const client = await getBigQueryClient(
      args.projectId,
      credentialsConfig,
      toolConfig,
      context,
    );
    const [, apiResponse] = await client
      .dataset(args.datasetId)
      .table(args.tableId)
      .get();
    return apiResponse;
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

/**
 * Get metadata information about a BigQuery job.
 */
export async function getJobInfo(
  args: {projectId: string; jobId: string},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  try {
    const client = await getBigQueryClient(
      args.projectId,
      credentialsConfig,
      toolConfig,
      context,
    );
    const [, apiResponse] = await client.job(args.jobId).get();
    return apiResponse;
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}
