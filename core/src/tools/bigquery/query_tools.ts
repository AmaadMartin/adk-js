/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {getBigQueryClient} from './client_helper.js';
import {
  BigQueryToolConfig,
  DEFAULT_BIGQUERY_TOOL_CONFIG,
  WriteMode,
} from './config.js';
import {BigQueryCredentialsConfig} from './credentials.js';

const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

/**
 * Run a BigQuery or BigQuery ML SQL query in the project and return the result.
 */
export async function executeSql(
  args: {projectId: string; query: string; dryRun?: boolean},
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  const {projectId, query, dryRun = false} = args;
  const settings = toolConfig || DEFAULT_BIGQUERY_TOOL_CONFIG;

  try {
    if (settings.computeProjectId && projectId !== settings.computeProjectId) {
      return {
        status: 'ERROR',
        error_details: `Cannot execute query in the project ${projectId}, as the tool is restricted to execute queries only in the project ${settings.computeProjectId}.`,
      };
    }

    const client = await getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      context,
    );

    const jobLabels = settings.jobLabels ? {...settings.jobLabels} : {};
    if (settings.applicationName) {
      jobLabels['adk-bigquery-application-name'] = settings.applicationName;
    }
    jobLabels['adk-bigquery-tool'] = 'execute_sql';

    const connectionProperties: {key: string; value: string}[] = [];

    if (settings.writeMode === WriteMode.BLOCKED) {
      const [job] = await client.createQueryJob({
        query,
        dryRun: true,
        labels: jobLabels,
      });
      const statementType = job.metadata.statistics?.query?.statementType;
      if (statementType !== 'SELECT') {
        return {
          status: 'ERROR',
          error_details: 'Read-only mode only supports SELECT statements.',
        };
      }
    } else if (settings.writeMode === WriteMode.PROTECTED && context) {
      const sessionInfo = context.state.get<[string, string]>(
        BIGQUERY_SESSION_INFO_KEY,
      );
      let sessionId: string;
      let sessionDatasetId: string;

      if (sessionInfo) {
        [sessionId, sessionDatasetId] = sessionInfo;
      } else {
        const [job] = await client.createQueryJob({
          query: 'SELECT 1',
          dryRun: true,
          createSession: true,
          labels: jobLabels,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        sessionId = job.metadata.statistics?.query?.sessionInfo?.sessionId;
        sessionDatasetId =
          job.metadata.configuration?.query?.destinationTable?.datasetId;

        if (!sessionId || !sessionDatasetId) {
          throw new Error('Failed to create BigQuery session.');
        }

        context.state.set(BIGQUERY_SESSION_INFO_KEY, [
          sessionId,
          sessionDatasetId,
        ]);
      }

      connectionProperties.push({key: 'session_id', value: sessionId});

      const [dryRunJob] = await client.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });

      const statementType = dryRunJob.metadata.statistics?.query?.statementType;
      const destinationDatasetId =
        dryRunJob.metadata.configuration?.query?.destinationTable?.datasetId;

      if (
        statementType !== 'SELECT' &&
        destinationDatasetId !== sessionDatasetId
      ) {
        return {
          status: 'ERROR',
          error_details:
            'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
        };
      }
    }

    if (dryRun) {
      const [job] = await client.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });
      return {
        status: 'SUCCESS',
        dry_run_info: job.metadata,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOptions: any = {
      query,
      connectionProperties,
      labels: jobLabels,
    };

    if (settings.maximumBytesBilled) {
      queryOptions.maximumBytesBilled = String(settings.maximumBytesBilled);
    }
    if (settings.maxQueryResultRows) {
      queryOptions.maxResults = settings.maxQueryResultRows;
    }

    const [rows] = await client.query(queryOptions);

    const formattedRows = (rows as Record<string, unknown>[]).map((row) => {
      const formattedRow: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        try {
          JSON.stringify(val);
          formattedRow[key] = val;
        } catch {
          formattedRow[key] = String(val);
        }
      }
      return formattedRow;
    });

    const result: Record<string, unknown> = {
      status: 'SUCCESS',
      rows: formattedRows,
    };

    if (
      settings.maxQueryResultRows &&
      formattedRows.length === settings.maxQueryResultRows
    ) {
      result.result_is_likely_truncated = true;
    }

    return result;
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

/**
 * Run a BigQuery AI time series forecast using AI.FORECAST.
 */
export async function forecast(
  args: {
    projectId: string;
    historyData: string;
    timestampCol: string;
    dataCol: string;
    horizon?: number;
    idCols?: string[];
  },
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  const {
    projectId,
    historyData,
    timestampCol,
    dataCol,
    horizon = 10,
    idCols,
  } = args;

  const model = 'TimesFM 2.0';
  const confidenceLevel = 0.95;
  const trimmedHistoryData = historyData.trim();
  const isQuery =
    trimmedHistoryData.toUpperCase().startsWith('SELECT') ||
    trimmedHistoryData.toUpperCase().startsWith('WITH');
  const historyDataSource = isQuery
    ? `(${historyData})`
    : `TABLE \`${historyData}\``;

  let query: string;

  if (idCols) {
    if (!idCols.every((item) => typeof item === 'string')) {
      return {
        status: 'ERROR',
        error_details: 'All elements in idCols must be strings.',
      };
    }
    const idColsStr = '[' + idCols.map((col) => `'${col}'`).join(', ') + ']';
    query = `
      SELECT * FROM AI.FORECAST(
        ${historyDataSource},
        data_col => '${dataCol}',
        timestamp_col => '${timestampCol}',
        model => '${model}',
        id_cols => ${idColsStr},
        horizon => ${horizon},
        confidence_level => ${confidenceLevel}
      )
    `;
  } else {
    query = `
      SELECT * FROM AI.FORECAST(
        ${historyDataSource},
        data_col => '${dataCol}',
        timestamp_col => '${timestampCol}',
        model => '${model}',
        horizon => ${horizon},
        confidence_level => ${confidenceLevel}
      )
    `;
  }

  return executeSql({projectId, query}, credentialsConfig, toolConfig, context);
}

/**
 * Run a BigQuery ML contribution analysis using ML.CREATE_MODEL and ML.GET_INSIGHTS.
 */
export async function analyzeContribution(
  args: {
    projectId: string;
    inputData: string;
    contributionMetric: string;
    dimensionIdCols: string[];
    isTestCol: string;
    topKInsights?: number;
    pruningMethod?: string;
  },
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  const {
    projectId,
    inputData,
    contributionMetric,
    dimensionIdCols,
    isTestCol,
    topKInsights = 30,
    pruningMethod = 'PRUNE_REDUNDANT_INSIGHTS',
  } = args;

  if (!dimensionIdCols.every((item) => typeof item === 'string')) {
    return {
      status: 'ERROR',
      error_details: 'All elements in dimensionIdCols must be strings.',
    };
  }

  const modelName = `contribution_analysis_model_${randomUUID().replace(/-/g, '_')}`;
  const idColsStr =
    '[' + dimensionIdCols.map((col) => `'${col}'`).join(', ') + ']';

  const options = [
    "MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'",
    `CONTRIBUTION_METRIC = '${contributionMetric}'`,
    `IS_TEST_COL = '${isTestCol}'`,
    `DIMENSION_ID_COLS = ${idColsStr}`,
  ];

  options.push(`TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = ${topKInsights}`);

  const upperPruning = pruningMethod.toUpperCase();
  if (
    upperPruning !== 'NO_PRUNING' &&
    upperPruning !== 'PRUNE_REDUNDANT_INSIGHTS'
  ) {
    return {
      status: 'ERROR',
      error_details: `Invalid pruningMethod: ${pruningMethod}`,
    };
  }
  options.push(`PRUNING_METHOD = '${upperPruning}'`);

  const optionsStr = options.join(', ');

  const trimmedInputData = inputData.trim();
  const isQuery =
    trimmedInputData.toUpperCase().startsWith('SELECT') ||
    trimmedInputData.toUpperCase().startsWith('WITH');
  const inputDataSource = isQuery
    ? `(${inputData})`
    : `SELECT * FROM \`${inputData}\``;

  const createModelQuery = `
    CREATE TEMP MODEL ${modelName}
      OPTIONS (${optionsStr})
    AS ${inputDataSource}
  `;

  const getInsightsQuery = `
    SELECT * FROM ML.GET_INSIGHTS(MODEL ${modelName})
  `;

  try {
    const settings = toolConfig
      ? {...toolConfig}
      : {...DEFAULT_BIGQUERY_TOOL_CONFIG};
    if (settings.writeMode === WriteMode.BLOCKED) {
      throw new Error('analyzeContribution is not allowed in this session.');
    } else if (settings.writeMode !== WriteMode.PROTECTED) {
      settings.writeMode = WriteMode.PROTECTED;
    }

    const createResult = await executeSql(
      {projectId, query: createModelQuery},
      credentialsConfig,
      settings,
      context,
    );

    if (createResult.status !== 'SUCCESS') {
      return createResult;
    }

    return executeSql(
      {projectId, query: getInsightsQuery},
      credentialsConfig,
      settings,
      context,
    );
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: `Error during analyzeContribution: ${ex instanceof Error ? ex.message : String(ex)}`,
    };
  }
}

/**
 * Run a BigQuery time series ARIMA_PLUS model training and anomaly detection.
 */
export async function detectAnomalies(
  args: {
    projectId: string;
    historyData: string;
    timesSeriesTimestampCol: string;
    timesSeriesDataCol: string;
    horizon?: number;
    targetData?: string;
    timesSeriesIdCols?: string[];
    anomalyProbThreshold?: number;
  },
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<unknown> {
  const {
    projectId,
    historyData,
    timesSeriesTimestampCol,
    timesSeriesDataCol,
    horizon = 1000,
    targetData,
    timesSeriesIdCols,
    anomalyProbThreshold = 0.95,
  } = args;

  const trimmedHistoryData = historyData.trim();
  const isQuery =
    trimmedHistoryData.toUpperCase().startsWith('SELECT') ||
    trimmedHistoryData.toUpperCase().startsWith('WITH');
  const historyDataSource = isQuery
    ? `(${historyData})`
    : `SELECT * FROM \`${historyData}\``;

  const options = [
    "MODEL_TYPE = 'ARIMA_PLUS'",
    `TIME_SERIES_TIMESTAMP_COL = '${timesSeriesTimestampCol}'`,
    `TIME_SERIES_DATA_COL = '${timesSeriesDataCol}'`,
    `HORIZON = ${horizon}`,
  ];

  if (timesSeriesIdCols) {
    if (!timesSeriesIdCols.every((item) => typeof item === 'string')) {
      return {
        status: 'ERROR',
        error_details: 'All elements in timesSeriesIdCols must be strings.',
      };
    }
    const idColsStr =
      '[' + timesSeriesIdCols.map((col) => `'${col}'`).join(', ') + ']';
    options.push(`TIME_SERIES_ID_COL = ${idColsStr}`);
  }

  const optionsStr = options.join(', ');
  const modelName = `detect_anomalies_model_${randomUUID().replace(/-/g, '_')}`;

  const createModelQuery = `
    CREATE TEMP MODEL ${modelName}
      OPTIONS (${optionsStr})
    AS ${historyDataSource}
  `;

  const orderByIdCols = timesSeriesIdCols
    ? timesSeriesIdCols.join(', ') + ', '
    : '';
  let anomalyDetectionQuery = `
    SELECT * FROM ML.DETECT_ANOMALIES(MODEL ${modelName}, STRUCT(${anomalyProbThreshold} AS anomaly_prob_threshold)) ORDER BY ${orderByIdCols}${timesSeriesTimestampCol}
  `;

  if (targetData) {
    const trimmedTargetData = targetData.trim();
    const isTargetQuery =
      trimmedTargetData.toUpperCase().startsWith('SELECT') ||
      trimmedTargetData.toUpperCase().startsWith('WITH');
    const targetDataSource = isTargetQuery
      ? `(${targetData})`
      : `(SELECT * FROM \`${targetData}\`)`;

    anomalyDetectionQuery = `
      SELECT * FROM ML.DETECT_ANOMALIES(MODEL ${modelName}, STRUCT(${anomalyProbThreshold} AS anomaly_prob_threshold), ${targetDataSource}) ORDER BY ${orderByIdCols}${timesSeriesTimestampCol}
    `;
  }

  try {
    const settings = toolConfig
      ? {...toolConfig}
      : {...DEFAULT_BIGQUERY_TOOL_CONFIG};
    if (settings.writeMode === WriteMode.BLOCKED) {
      throw new Error('anomaly detection is not allowed in this session.');
    } else if (settings.writeMode !== WriteMode.PROTECTED) {
      settings.writeMode = WriteMode.PROTECTED;
    }

    const createResult = await executeSql(
      {projectId, query: createModelQuery},
      credentialsConfig,
      settings,
      context,
    );

    if (createResult.status !== 'SUCCESS') {
      return createResult;
    }

    return executeSql(
      {projectId, query: anomalyDetectionQuery},
      credentialsConfig,
      settings,
      context,
    );
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: `Error during anomaly detection: ${ex instanceof Error ? ex.message : String(ex)}`,
    };
  }
}
