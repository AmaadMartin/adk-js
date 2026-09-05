/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery} from '@google-cloud/bigquery';
import type {AuthClient} from 'google-auth-library';
import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {ToolInputParameters} from '../../tools/function_tool.js';
import {
  GoogleTool,
  GoogleToolExecuteContext,
  GoogleToolExecuteFunction,
} from '../../tools/google_tool.js';
import {experimental} from '../../utils/experimental.js';

import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {getBigQueryClient, getDataplexCatalogClient} from './client.js';
import {
  BigQueryToolConfig,
  BigQueryToolSettings,
  createBigQueryToolSettings,
} from './config.js';
import {askDataInsights} from './data_insights_tool.js';
import {
  getDatasetInfo,
  getJobInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from './metadata_tool.js';
import {
  DEFAULT_ANOMALY_HORIZON,
  DEFAULT_ANOMALY_PROB_THRESHOLD,
  DEFAULT_FORECAST_HORIZON,
  DEFAULT_TOP_K_INSIGHTS,
  PRUNING_METHODS,
  analyzeContribution,
  detectAnomalies,
  executeSqlDescription,
  executeSqlQuery,
  forecast,
} from './query_tool.js';
import {DEFAULT_SEARCH_PAGE_SIZE, searchCatalog} from './search_tool.js';

const projectId = z
  .string()
  .describe('The Google Cloud project id the call runs in.');
const datasetId = z.string().describe('The BigQuery dataset id.');

const ProjectSchema = z.object({projectId});
const DatasetSchema = z.object({projectId, datasetId});
const TableSchema = z.object({
  projectId,
  datasetId,
  tableId: z.string().describe('The BigQuery table id.'),
});
const JobSchema = z.object({
  projectId,
  jobId: z
    .string()
    .describe(
      'The BigQuery job id, either bare or as `project_id:region.job_id`.',
    ),
});
const ExecuteSqlSchema = z.object({
  projectId,
  query: z.string().describe('The BigQuery SQL statement to run.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Validate and cost the query instead of running it.'),
});
const ForecastSchema = z.object({
  projectId,
  historyData: z
    .string()
    .describe(
      'The table id holding the history time series, or a query selecting it.',
    ),
  timestampCol: z.string().describe('The column holding each point in time.'),
  dataCol: z.string().describe('The column holding the values to forecast.'),
  horizon: z
    .number()
    .optional()
    .describe(
      `How many steps ahead to forecast. Defaults to ${DEFAULT_FORECAST_HORIZON}.`,
    ),
  idCols: z
    .array(z.string())
    .optional()
    .describe('The columns telling one time series from another.'),
});
const AnalyzeContributionSchema = z.object({
  projectId,
  inputData: z
    .string()
    .describe(
      'The table id holding the test and control data, or a query selecting it.',
    ),
  contributionMetric: z
    .string()
    .describe(
      'The metric to explain, as SUM(x), SUM(x)/SUM(y), or' +
        ' SUM(x)/COUNT(DISTINCT y).',
    ),
  dimensionIdCols: z
    .array(z.string())
    .describe('The dimension columns the analysis groups by.'),
  isTestCol: z
    .string()
    .describe('The BOOL column separating test rows from control rows.'),
  topKInsights: z
    .number()
    .optional()
    .describe(
      `How many insights to report. Defaults to ${DEFAULT_TOP_K_INSIGHTS}.`,
    ),
  pruningMethod: z
    .enum(PRUNING_METHODS)
    .optional()
    .describe(
      `How to prune redundant insights. Defaults to ${PRUNING_METHODS[1]}.`,
    ),
});
const DetectAnomaliesSchema = z.object({
  projectId,
  historyData: z
    .string()
    .describe(
      'The table id holding the history time series, or a query selecting it.',
    ),
  timesSeriesTimestampCol: z
    .string()
    .describe('The column holding each point in time.'),
  timesSeriesDataCol: z
    .string()
    .describe('The column holding the values to inspect.'),
  horizon: z
    .number()
    .optional()
    .describe(
      `How many steps ahead to model. Defaults to ${DEFAULT_ANOMALY_HORIZON}.`,
    ),
  targetData: z
    .string()
    .optional()
    .describe(
      'The table id holding the data to inspect, or a query selecting it.' +
        ' Defaults to the history data itself.',
    ),
  timesSeriesIdCols: z
    .array(z.string())
    .optional()
    .describe('The columns telling one time series from another.'),
  anomalyProbThreshold: z
    .number()
    .optional()
    .describe(
      'The probability above which a point counts as an anomaly. Defaults to' +
        ` ${DEFAULT_ANOMALY_PROB_THRESHOLD}.`,
    ),
});
const AskDataInsightsSchema = z.object({
  projectId,
  userQueryWithContext: z
    .string()
    .describe(
      "The user's question, enriched with enough conversation history to" +
        ' resolve it on its own.',
    ),
  tableReferences: z
    .array(
      z.object({
        projectId,
        datasetId,
        tableId: z.string().describe('The BigQuery table id.'),
      }),
    )
    .describe('The tables the question may be answered from.'),
});
const SearchCatalogSchema = z.object({
  projectId,
  prompt: z
    .string()
    .describe('What to look for, in natural language or as keywords.'),
  location: z.string().optional().describe('The Dataplex location to search.'),
  pageSize: z
    .number()
    .optional()
    .describe(
      `How many entries to return. Defaults to ${DEFAULT_SEARCH_PAGE_SIZE}.`,
    ),
  projectIdsFilter: z
    .array(z.string())
    .optional()
    .describe('The projects to search. Defaults to the scoping project.'),
  datasetIdsFilter: z
    .array(z.string())
    .optional()
    .describe('The datasets to search within the matched projects.'),
  typesFilter: z
    .array(z.string())
    .optional()
    .describe('The Dataplex entry types to match.'),
});

/** Options accepted by {@link BigQueryToolset}. */
export interface BigQueryToolsetOptions {
  /**
   * Which tools to expose: a list of tool names, or a predicate. An empty
   * list exposes none. Leave it unset to expose all of them.
   */
  toolFilter?: ToolPredicate | string[];
  /** How the tools obtain credentials. Unset means application default. */
  credentialsConfig?: BigQueryCredentialsConfig;
  /** Settings shared by every tool. Unset means every default. */
  bigqueryToolConfig?: BigQueryToolConfig;
}

/** The filter a toolset built without one uses: every tool is admitted. */
const passAll: ToolPredicate = () => true;

/**
 * Tools for reading BigQuery data and metadata (Experimental).
 *
 * The eleven tools it exposes are `get_dataset_info`, `get_table_info`,
 * `list_dataset_ids`, `list_table_ids`, `get_job_info`, `execute_sql`,
 * `forecast`, `analyze_contribution`, `detect_anomalies`,
 * `ask_data_insights` and `search_catalog`.
 *
 * `execute_sql` refuses anything but a read until
 * {@link BigQueryToolConfig.writeMode} says otherwise, and the description the
 * model reads changes with it.
 *
 * Constructing the toolset performs no input or output: it validates the
 * configuration, and nothing else. The BigQuery package is loaded, and a
 * client opened, on the first tool call.
 *
 * Please do not use this in production, as it may be deprecated later.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'bigquery_agent',
 *   model: 'gemini-2.0-flash',
 *   instruction: 'Answer questions about the user BigQuery data.',
 *   tools: [new BigQueryToolset()],
 * });
 * ```
 */
@experimental
export class BigQueryToolset extends BaseToolset {
  private readonly credentialsConfig?: BigQueryCredentialsConfig;
  private readonly toolSettings: BigQueryToolSettings;

  /**
   * @param options Which tools to expose, how they authenticate, and the
   *     settings they share.
   * @throws {z.ZodError} If `bigqueryToolConfig` breaks a validation rule, or
   *     carries a key the configuration does not declare.
   */
  constructor(options: BigQueryToolsetOptions = {}) {
    // An unset filter becomes a pass-all predicate rather than `[]`, because
    // the base class reads `[]` as no filter while adk-python reads it as a
    // membership test that nothing satisfies.
    super(options.toolFilter ?? passAll);
    this.credentialsConfig = options.credentialsConfig;
    this.toolSettings = createBigQueryToolSettings(options.bigqueryToolConfig);
  }

  /**
   * Returns the tools the filter admits, in a stable order.
   *
   * @param context Context a predicate filter reads. A list filter ignores it.
   * @return The admitted tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.buildTools().filter((tool) => this.isSelected(tool, context));
  }

  /**
   * Releases what the toolset holds.
   *
   * Nothing is cached: a BigQuery client is built per call and a Dataplex
   * client is closed by the call that opened it, so this has nothing to do.
   * adk-python's `close()` is a bare `pass` for the same reason.
   */
  override async close(): Promise<void> {}

  /**
   * Whether the filter admits a tool.
   *
   * A list is a membership test, so an empty list admits nothing. A predicate
   * with no context to read admits the tool, as `BigtableToolset` does.
   */
  private isSelected(tool: BaseTool, context?: ReadonlyContext): boolean {
    if (typeof this.toolFilter === 'function') {
      return context === undefined || this.toolFilter(tool, context);
    }
    return this.toolFilter.includes(tool.name);
  }

  /** Builds the tool for one BigQuery operation. */
  private buildTool<TParameters extends ToolInputParameters>(
    name: string,
    description: string,
    parameters: TParameters,
    execute: GoogleToolExecuteFunction<TParameters, BigQueryToolSettings>,
  ): BaseTool {
    return new GoogleTool({
      name,
      description,
      parameters,
      execute,
      credentialsConfig: this.credentialsConfig,
      toolSettings: this.toolSettings,
    });
  }

  /** Opens a BigQuery client identifying itself as `toolName`. */
  private client(
    project: string,
    google: GoogleToolExecuteContext<BigQueryToolSettings> | undefined,
    toolName: string,
  ): Promise<BigQuery> {
    return getBigQueryClient({
      project,
      credentials: google?.credentials,
      location: google?.settings?.location,
      userAgent: [google?.settings?.applicationName, toolName],
    });
  }

  /** The settings a tool runs with, falling back to the toolset's own. */
  private settingsOf(
    google: GoogleToolExecuteContext<BigQueryToolSettings> | undefined,
  ): BigQueryToolSettings {
    return google?.settings ?? this.toolSettings;
  }

  /** Builds one tool per BigQuery operation, in the reference's order. */
  private buildTools(): BaseTool[] {
    return [
      this.buildTool(
        'get_dataset_info',
        'Get the metadata of a BigQuery dataset.',
        DatasetSchema,
        async (input, _toolContext, google) =>
          getDatasetInfo(
            await this.client(input.projectId, google, 'get_dataset_info'),
            input.projectId,
            input.datasetId,
          ),
      ),
      this.buildTool(
        'get_table_info',
        'Get the metadata of a BigQuery table, including its schema.',
        TableSchema,
        async (input, _toolContext, google) =>
          getTableInfo(
            await this.client(input.projectId, google, 'get_table_info'),
            input.projectId,
            input.datasetId,
            input.tableId,
          ),
      ),
      this.buildTool(
        'list_dataset_ids',
        'List the BigQuery dataset ids in a Google Cloud project.',
        ProjectSchema,
        async (input, _toolContext, google) =>
          listDatasetIds(
            await this.client(input.projectId, google, 'list_dataset_ids'),
            input.projectId,
          ),
      ),
      this.buildTool(
        'list_table_ids',
        'List the table ids in a BigQuery dataset.',
        DatasetSchema,
        async (input, _toolContext, google) =>
          listTableIds(
            await this.client(input.projectId, google, 'list_table_ids'),
            input.projectId,
            input.datasetId,
          ),
      ),
      this.buildTool(
        'get_job_info',
        'Get the metadata of a BigQuery job: its configuration, statistics,' +
          ' status, slot usage and original query.',
        JobSchema,
        async (input, _toolContext, google) =>
          getJobInfo(
            await this.client(input.projectId, google, 'get_job_info'),
            input.jobId,
          ),
      ),
      this.buildTool(
        'execute_sql',
        executeSqlDescription(this.toolSettings.writeMode),
        ExecuteSqlSchema,
        async (input, toolContext, google) =>
          executeSqlQuery({
            client: await this.client(input.projectId, google, 'execute_sql'),
            projectId: input.projectId,
            query: input.query,
            settings: this.settingsOf(google),
            toolContext,
            dryRun: input.dryRun,
            callerId: 'execute_sql',
          }),
      ),
      this.buildTool(
        'forecast',
        'Forecast a time series held in BigQuery with AI.FORECAST.',
        ForecastSchema,
        async (input, toolContext, google) =>
          forecast(
            await this.client(input.projectId, google, 'forecast'),
            input,
            this.settingsOf(google),
            toolContext,
          ),
      ),
      this.buildTool(
        'analyze_contribution',
        'Explain a change in a metric with a BigQuery ML contribution' +
          ' analysis. It creates a temporary model, so the toolset must allow' +
          ' writes.',
        AnalyzeContributionSchema,
        async (input, toolContext, google) =>
          analyzeContribution(
            await this.client(input.projectId, google, 'analyze_contribution'),
            input,
            this.settingsOf(google),
            toolContext,
          ),
      ),
      this.buildTool(
        'detect_anomalies',
        'Find anomalies in a time series with a BigQuery ML ARIMA_PLUS model.' +
          ' It creates a temporary model, so the toolset must allow writes.',
        DetectAnomaliesSchema,
        async (input, toolContext, google) =>
          detectAnomalies(
            await this.client(input.projectId, google, 'detect_anomalies'),
            input,
            this.settingsOf(google),
            toolContext,
          ),
      ),
      this.buildTool(
        'ask_data_insights',
        'Answer a question about BigQuery tables in natural language. It' +
          ' returns the whole log of the work: the statements that ran, the' +
          ' rows they read, and the answer.',
        AskDataInsightsSchema,
        (input, _toolContext, google) =>
          askDataInsights(input, this.settingsOf(google), google?.credentials),
      ),
      this.buildTool(
        'search_catalog',
        'Find BigQuery datasets and tables by meaning rather than by name.' +
          ' Use it when the exact ids are unknown.',
        SearchCatalogSchema,
        async (input, _toolContext, google) =>
          this.withCatalogClient(google?.credentials, (client) =>
            searchCatalog(client, input, this.settingsOf(google)),
          ),
      ),
    ];
  }

  /**
   * Runs `use` against a Dataplex client, then closes it.
   *
   * The client owns a gRPC channel, so it is released on the failure path as
   * well. adk-python closes it the same way, with a `with` block.
   */
  private async withCatalogClient<T>(
    credentials: AuthClient | undefined,
    use: (
      client: Awaited<ReturnType<typeof getDataplexCatalogClient>>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await getDataplexCatalogClient({credentials});
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  }
}
