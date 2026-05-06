/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';
import {BigQueryToolConfig, DEFAULT_BIGQUERY_TOOL_CONFIG} from './config.js';
import {BigQueryCredentialsConfig} from './credentials.js';
import * as dataInsightsTool from './data_insights_tool.js';
import * as metadataTools from './metadata_tools.js';
import * as queryTools from './query_tools.js';
import * as searchTool from './search_tool.js';

/**
 * BigQuery Toolset contains tools for interacting with BigQuery data and metadata.
 */
export class BigQueryToolset extends BaseToolset {
  private readonly credentialsConfig?: BigQueryCredentialsConfig;
  private readonly toolConfig: BigQueryToolConfig;

  constructor(
    options: {
      toolFilter?: ToolPredicate | string[];
      credentialsConfig?: BigQueryCredentialsConfig;
      bigqueryToolConfig?: BigQueryToolConfig;
    } = {},
  ) {
    super(options.toolFilter || (() => true));
    this.credentialsConfig = options.credentialsConfig;
    this.toolConfig =
      options.bigqueryToolConfig || DEFAULT_BIGQUERY_TOOL_CONFIG;
  }

  /**
   * Get tools from the toolset.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const allTools = [
      new FunctionTool({
        name: 'list_dataset_ids',
        description: 'List BigQuery dataset ids in a Google Cloud project.',
        parameters: z.object({
          projectId: z.string().describe('The Google Cloud project id.'),
        }),
        execute: (args, toolContext) =>
          metadataTools.listDatasetIds(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'get_dataset_info',
        description: 'Get metadata information about a BigQuery dataset.',
        parameters: z.object({
          projectId: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          datasetId: z.string().describe('The BigQuery dataset id.'),
        }),
        execute: (args, toolContext) =>
          metadataTools.getDatasetInfo(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'list_table_ids',
        description: 'List table ids in a BigQuery dataset.',
        parameters: z.object({
          projectId: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          datasetId: z.string().describe('The BigQuery dataset id.'),
        }),
        execute: (args, toolContext) =>
          metadataTools.listTableIds(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'get_table_info',
        description: 'Get metadata information about a BigQuery table.',
        parameters: z.object({
          projectId: z
            .string()
            .describe('The Google Cloud project id containing the dataset.'),
          datasetId: z
            .string()
            .describe('The BigQuery dataset id containing the table.'),
          tableId: z.string().describe('The BigQuery table id.'),
        }),
        execute: (args, toolContext) =>
          metadataTools.getTableInfo(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'get_job_info',
        description: 'Get metadata information about a BigQuery job.',
        parameters: z.object({
          projectId: z
            .string()
            .describe('The Google Cloud project id containing the job.'),
          jobId: z.string().describe('The BigQuery job id.'),
        }),
        execute: (args, toolContext) =>
          metadataTools.getJobInfo(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'execute_sql',
        description:
          'Run a BigQuery or BigQuery ML SQL query in the project and return the result.',
        parameters: z.object({
          projectId: z
            .string()
            .describe(
              'The GCP project id in which the query should be executed.',
            ),
          query: z.string().describe('The BigQuery SQL query to be executed.'),
          dryRun: z
            .boolean()
            .optional()
            .describe(
              'If True, the query will not be executed. Instead, the query will be validated and information about the query will be returned. Defaults to False.',
            ),
        }),
        execute: (args, toolContext) =>
          queryTools.executeSql(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'forecast',
        description:
          'Run a BigQuery AI time series forecast using AI.FORECAST.',
        parameters: z.object({
          projectId: z
            .string()
            .describe(
              'The GCP project id in which the query should be executed.',
            ),
          historyData: z
            .string()
            .describe(
              'The table id of the BigQuery table containing the history time series data or a query statement that select the history data.',
            ),
          timestampCol: z
            .string()
            .describe(
              'The name of the column containing the timestamp for each data point.',
            ),
          dataCol: z
            .string()
            .describe(
              'The name of the column containing the numerical values to be forecasted.',
            ),
          horizon: z
            .number()
            .int()
            .optional()
            .describe(
              'The number of time steps to forecast into the future. Defaults to 10.',
            ),
          idCols: z
            .array(z.string())
            .optional()
            .describe(
              'The column names of the id columns to indicate each time series when there are multiple time series in the table.',
            ),
        }),
        execute: (args, toolContext) =>
          queryTools.forecast(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'analyze_contribution',
        description:
          'Run a BigQuery ML contribution analysis using ML.CREATE_MODEL and ML.GET_INSIGHTS.',
        parameters: z.object({
          projectId: z
            .string()
            .describe(
              'The GCP project id in which the query should be executed.',
            ),
          inputData: z
            .string()
            .describe(
              'The data that contain the test and control data to analyze. Can be a fully qualified BigQuery table ID or a SQL query.',
            ),
          contributionMetric: z
            .string()
            .describe(
              'The name of the column that contains the metric to analyze.',
            ),
          dimensionIdCols: z
            .array(z.string())
            .describe('The column names of the dimension columns.'),
          isTestCol: z
            .string()
            .describe(
              'The name of the column to use to determine whether a given row is test data or control data.',
            ),
          topKInsights: z
            .number()
            .int()
            .optional()
            .describe(
              'The number of top insights to return, ranked by apriori support. Defaults to 30.',
            ),
          pruningMethod: z
            .string()
            .optional()
            .describe(
              'The method to use for pruning redundant insights. Can be "NO_PRUNING" or "PRUNE_REDUNDANT_INSIGHTS". Defaults to "PRUNE_REDUNDANT_INSIGHTS".',
            ),
        }),
        execute: (args, toolContext) =>
          queryTools.analyzeContribution(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'detect_anomalies',
        description:
          'Run a BigQuery time series ARIMA_PLUS model training and anomaly detection.',
        parameters: z.object({
          projectId: z
            .string()
            .describe(
              'The GCP project id in which the query should be executed.',
            ),
          historyData: z
            .string()
            .describe(
              'The table id of the BigQuery table containing the history time series data or a query statement that select the history data.',
            ),
          timesSeriesTimestampCol: z
            .string()
            .describe(
              'The name of the column containing the timestamp for each data point.',
            ),
          timesSeriesDataCol: z
            .string()
            .describe(
              'The name of the column containing the numerical values to be forecasted and anomaly detected.',
            ),
          horizon: z
            .number()
            .int()
            .optional()
            .describe(
              'The number of time steps to forecast into the future. Defaults to 1000.',
            ),
          targetData: z
            .string()
            .optional()
            .describe(
              'The table id of the BigQuery table containing the target time series data or a query statement that select the target data.',
            ),
          timesSeriesIdCols: z
            .array(z.string())
            .optional()
            .describe(
              'The column names of the id columns to indicate each time series when there are multiple time series in the table.',
            ),
          anomalyProbThreshold: z
            .number()
            .optional()
            .describe(
              'The probability threshold to determine if a data point is an anomaly. Defaults to 0.95.',
            ),
        }),
        execute: (args, toolContext) =>
          queryTools.detectAnomalies(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'ask_data_insights',
        description:
          'Answers questions about structured data in BigQuery tables using natural language.',
        parameters: z.object({
          projectId: z
            .string()
            .describe('The project that the inquiry is performed in.'),
          userQueryWithContext: z
            .string()
            .describe(
              "The user's original request, enriched with relevant context from the conversation history.",
            ),
          tableReferences: z
            .array(
              z.object({
                projectId: z.string(),
                datasetId: z.string(),
                tableId: z.string(),
              }),
            )
            .describe('A list of tables to be used as context.'),
        }),
        execute: (args, toolContext) =>
          dataInsightsTool.askDataInsights(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
      new FunctionTool({
        name: 'search_catalog',
        description:
          'Finds BigQuery datasets and tables using natural language semantic search via Dataplex.',
        parameters: z.object({
          prompt: z
            .string()
            .describe('The base search query (natural language or keywords).'),
          projectId: z
            .string()
            .describe('The Google Cloud project ID to scope the search.'),
          location: z
            .string()
            .optional()
            .describe('The Dataplex location to use.'),
          pageSize: z
            .number()
            .int()
            .optional()
            .describe('Maximum number of results. Defaults to 10.'),
          projectIdsFilter: z
            .array(z.string())
            .optional()
            .describe('Specific project IDs to include in the search results.'),
          datasetIdsFilter: z
            .array(z.string())
            .optional()
            .describe('BigQuery dataset IDs to filter by.'),
          typesFilter: z
            .array(z.string())
            .optional()
            .describe('Entry types to filter by.'),
        }),
        execute: (args, toolContext) =>
          searchTool.searchCatalog(
            args,
            this.credentialsConfig,
            this.toolConfig,
            toolContext,
          ),
      }),
    ];

    return allTools.filter((tool) =>
      context ? this.isToolSelected(tool, context) : true,
    );
  }

  /**
   * Close the toolset.
   */
  async close(): Promise<void> {
    // No-op
  }
}
