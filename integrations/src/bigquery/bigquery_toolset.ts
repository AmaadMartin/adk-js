/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  FunctionTool,
  ReadonlyContext,
  ToolPredicate,
} from '@google/adk';
import {z} from 'zod/v3';

import {BigQueryToolConfig} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import * as metadataTools from './metadata_tools.js';
import * as queryTools from './query_tools.js';

export class BigQueryToolset extends BaseToolset {
  private readonly credentialsConfig?: BigQueryCredentialsConfig;
  private readonly toolSettings: BigQueryToolConfig;

  constructor(
    toolFilter?: ToolPredicate | string[],
    credentialsConfig?: BigQueryCredentialsConfig,
    bigqueryToolConfig?: BigQueryToolConfig,
  ) {
    super(toolFilter || []);
    this.credentialsConfig = credentialsConfig;
    this.toolSettings = bigqueryToolConfig || {};
  }

  async getTools(readonlyContext?: ReadonlyContext): Promise<BaseTool[]> {
    const allTools = [
      new FunctionTool({
        name: 'get_dataset_info',
        description: 'Get metadata information about a BigQuery dataset.',
        parameters: z.object({
          project_id: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          dataset_id: z.string().describe('The BigQuery dataset id.'),
        }),
        execute: async (args) => {
          return metadataTools.getDatasetInfo(
            args.project_id,
            args.dataset_id,
            this.credentialsConfig,
            this.toolSettings,
          );
        },
      }),
      new FunctionTool({
        name: 'list_dataset_ids',
        description: 'List BigQuery dataset ids in a Google Cloud project.',
        parameters: z.object({
          project_id: z.string().describe('The Google Cloud project id.'),
        }),
        execute: async (args) => {
          return metadataTools.listDatasetIds(
            args.project_id,
            this.credentialsConfig,
            this.toolSettings,
          );
        },
      }),
      new FunctionTool({
        name: 'get_table_info',
        description: 'Get metadata information about a BigQuery table.',
        parameters: z.object({
          project_id: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          dataset_id: z
            .string()
            .describe('The BigQuery dataset id containing the table.'),
          table_id: z.string().describe('The BigQuery table id.'),
        }),
        execute: async (args) => {
          return metadataTools.getTableInfo(
            args.project_id,
            args.dataset_id,
            args.table_id,
            this.credentialsConfig,
            this.toolSettings,
          );
        },
      }),
      new FunctionTool({
        name: 'list_table_ids',
        description: 'List table ids in a BigQuery dataset.',
        parameters: z.object({
          project_id: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          dataset_id: z.string().describe('The BigQuery dataset id.'),
        }),
        execute: async (args) => {
          return metadataTools.listTableIds(
            args.project_id,
            args.dataset_id,
            this.credentialsConfig,
            this.toolSettings,
          );
        },
      }),
      new FunctionTool({
        name: 'get_job_info',
        description: 'Get metadata information about a BigQuery job.',
        parameters: z.object({
          project_id: z
            .string()
            .describe('The Google Cloud project id associated with the job.'),
          job_id: z.string().describe('The BigQuery job id.'),
          location: z.string().optional().describe('The location of the job.'),
        }),
        execute: async (args) => {
          return metadataTools.getJobInfo(
            args.project_id,
            args.job_id,
            args.location,
            this.credentialsConfig,
            this.toolSettings,
          );
        },
      }),
      new FunctionTool({
        name: 'execute_sql',
        description:
          'Run a BigQuery or BigQuery ML SQL query in the project and return the result.',
        parameters: z.object({
          project_id: z
            .string()
            .describe(
              'The GCP project id in which the query should be executed.',
            ),
          query: z.string().describe('The BigQuery SQL query to be executed.'),
          dry_run: z
            .boolean()
            .optional()
            .default(false)
            .describe('If true, the query will not be executed.'),
        }),
        execute: async (args, toolContext) => {
          return queryTools.executeSql(
            args.project_id,
            args.query,
            this.credentialsConfig,
            this.toolSettings,
            toolContext,
            args.dry_run,
          );
        },
      }),
    ];

    if (!readonlyContext) {
      // The base contract allows `getTools()` with no context, in which case a
      // `ToolPredicate` cannot be evaluated. Fall back to name filtering, as
      // `OpenApiToolset` does, rather than handing the predicate a fake
      // context that would throw the moment it reads `state` or `agentName`.
      return allTools.filter(
        (tool) =>
          !Array.isArray(this.toolFilter) ||
          this.toolFilter.length === 0 ||
          this.toolFilter.includes(tool.name),
      );
    }

    return allTools.filter((tool) =>
      this.isToolSelected(tool, readonlyContext),
    );
  }

  async close(): Promise<void> {
    // No-op: the BigQuery client holds no persistent connection to release.
  }
}
