/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {WriteMode} from '../../../src/tools/bigquery/config.js';
import * as queryTools from '../../../src/tools/bigquery/query_tools.js';

const mockCreateQueryJob = vi.fn();
const mockQuery = vi.fn();

vi.mock('@google-cloud/bigquery', () => {
  return {
    BigQuery: vi.fn().mockImplementation(() => {
      return {
        createQueryJob: mockCreateQueryJob,
        query: mockQuery,
      };
    }),
  };
});

vi.mock('../../../src/utils/env_aware_utils.js', () => ({
  randomUUID: () => 'mocked-uuid-123',
}));

describe('Query Tools', () => {
  let context: Context;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateQueryJob.mockReset();
    mockQuery.mockReset();
    context = new Context({
      invocationContext: {
        session: {id: 'session-1', state: new Map()},
      } as unknown as InvocationContext,
      functionCallId: 'test-call-id',
    });
  });

  const setupProtectedModeMocks = () => {
    mockCreateQueryJob
      .mockResolvedValueOnce([
        {
          metadata: {
            statistics: {
              query: {sessionInfo: {sessionId: 'session-id-123'}},
            },
            configuration: {
              query: {destinationTable: {datasetId: 'temp-dataset-123'}},
            },
          },
        },
      ]) // session creation
      .mockResolvedValueOnce([
        {
          metadata: {
            statistics: {query: {statementType: 'CREATE_MODEL'}},
            configuration: {
              query: {destinationTable: {datasetId: 'temp-dataset-123'}},
            },
          },
        },
      ]) // dry run 1
      .mockResolvedValueOnce([
        {
          metadata: {
            statistics: {query: {statementType: 'SELECT'}},
            configuration: {
              query: {destinationTable: {datasetId: 'temp-dataset-123'}},
            },
          },
        },
      ]); // dry run 2
  };

  describe('executeSql', () => {
    it('should fail if computeProjectId does not match', async () => {
      const result = await queryTools.executeSql(
        {projectId: 'wrong-project', query: 'SELECT 1'},
        undefined,
        {
          writeMode: WriteMode.BLOCKED,
          computeProjectId: 'allowed-project',
          maxQueryResultRows: 50,
        },
      );
      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'restricted to execute queries only in the project',
      );
    });

    it('BLOCKED mode should allow SELECT query', async () => {
      mockCreateQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'SELECT'}},
          },
        },
      ]);
      mockQuery.mockResolvedValue([[{col: 1}]]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.BLOCKED, maxQueryResultRows: 50},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(result.rows).toEqual([{col: 1}]);
      expect(mockCreateQueryJob).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'SELECT 1',
          dryRun: true,
        }),
      );
      expect(mockQuery).toHaveBeenCalled();
    });

    it('BLOCKED mode should deny non-SELECT query', async () => {
      mockCreateQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'CREATE_TABLE'}},
          },
        },
      ]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'CREATE TABLE ...'},
        undefined,
        {writeMode: WriteMode.BLOCKED, maxQueryResultRows: 50},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'Read-only mode only supports SELECT statements.',
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('PROTECTED mode should create session and allow temp table writes', async () => {
      mockCreateQueryJob
        .mockResolvedValueOnce([
          {
            metadata: {
              statistics: {
                query: {sessionInfo: {sessionId: 'session-id-123'}},
              },
              configuration: {
                query: {destinationTable: {datasetId: 'temp-dataset-123'}},
              },
            },
          },
        ])
        .mockResolvedValueOnce([
          {
            metadata: {
              statistics: {query: {statementType: 'CREATE_TABLE'}},
              configuration: {
                query: {destinationTable: {datasetId: 'temp-dataset-123'}},
              },
            },
          },
        ]);

      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'CREATE TEMP TABLE ...'},
        undefined,
        {writeMode: WriteMode.PROTECTED, maxQueryResultRows: 50},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(context.state.get('bigquery_session_info')).toEqual([
        'session-id-123',
        'temp-dataset-123',
      ]);

      expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);
      expect(mockCreateQueryJob).toHaveBeenLastCalledWith(
        expect.objectContaining({
          connectionProperties: [{key: 'session_id', value: 'session-id-123'}],
        }),
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionProperties: [{key: 'session_id', value: 'session-id-123'}],
        }),
      );
    });

    it('PROTECTED mode should deny permanent table writes', async () => {
      context.state.set('bigquery_session_info', [
        'session-id-123',
        'temp-dataset-123',
      ]);

      mockCreateQueryJob.mockResolvedValueOnce([
        {
          metadata: {
            statistics: {query: {statementType: 'CREATE_TABLE'}},
            configuration: {
              query: {destinationTable: {datasetId: 'permanent-dataset'}},
            },
          },
        },
      ]);

      const result = await queryTools.executeSql(
        {
          projectId: 'project',
          query: 'CREATE TABLE permanent-dataset.table ...',
        },
        undefined,
        {writeMode: WriteMode.PROTECTED, maxQueryResultRows: 50},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset',
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should handle dryRun: true successfully', async () => {
      const mockMetadata = {kind: 'bigquery#job', id: 'job-1'};
      mockCreateQueryJob.mockResolvedValue([{metadata: mockMetadata}]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1', dryRun: true},
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(result.dry_run_info).toEqual(mockMetadata);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should apply maximumBytesBilled and maxQueryResultRows in query options', async () => {
      mockQuery.mockResolvedValue([[]]);

      await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {
          writeMode: WriteMode.ALLOWED,
          maximumBytesBilled: 1000,
          maxQueryResultRows: 10,
        },
        context,
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          maximumBytesBilled: '1000',
          maxResults: 10,
        }),
      );
    });

    it('should set result_is_likely_truncated if rows count equals maxQueryResultRows', async () => {
      mockQuery.mockResolvedValue([[{id: 1}, {id: 2}]]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED, maxQueryResultRows: 2},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(result.result_is_likely_truncated).toBe(true);
    });

    it('should handle non-serializable values in rows by converting to string', async () => {
      const circular: any = {};
      circular.self = circular;
      mockQuery.mockResolvedValue([[{id: 1, val: circular}]]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(result.rows[0].val).toBe('[object Object]');
    });

    it('should handle API errors in executeSql', async () => {
      mockQuery.mockRejectedValue(new Error('Query Failed'));

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toBe('Query Failed');
    });

    it('should apply applicationName in job labels', async () => {
      mockCreateQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'SELECT'}},
          },
        },
      ]);
      mockQuery.mockResolvedValue([[]]);

      await queryTools.executeSql(
        {projectId: 'project', query: 'SELECT 1'},
        undefined,
        {
          writeMode: WriteMode.BLOCKED,
          applicationName: 'my-app',
        },
        context,
      );

      expect(mockCreateQueryJob).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            'adk-bigquery-application-name': 'my-app',
          }),
        }),
      );
    });

    it('should fail in PROTECTED mode if session creation returns missing sessionId or datasetId', async () => {
      mockCreateQueryJob.mockResolvedValueOnce([
        {
          metadata: {
            statistics: {
              query: {sessionInfo: {}},
            },
            configuration: {
              query: {},
            },
          },
        },
      ]);

      const result = await queryTools.executeSql(
        {projectId: 'project', query: 'CREATE TEMP TABLE ...'},
        undefined,
        {writeMode: WriteMode.PROTECTED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'Failed to create BigQuery session.',
      );
    });
  });

  describe('forecast', () => {
    it('should construct correct query and execute it', async () => {
      mockQuery.mockResolvedValue([[{forecast_value: 10}]]);

      const result = await queryTools.forecast(
        {
          projectId: 'project',
          historyData: 'dataset.table',
          timestampCol: 'time',
          dataCol: 'val',
          horizon: 5,
        },
        undefined,
        {writeMode: WriteMode.ALLOWED, maxQueryResultRows: 50},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('AI.FORECAST'),
        }),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('TABLE `dataset.table`'),
        }),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('horizon => 5'),
        }),
      );
    });

    it('should handle historyData as query', async () => {
      mockQuery.mockResolvedValue([[]]);

      await queryTools.forecast(
        {
          projectId: 'project',
          historyData: 'SELECT time, val FROM t',
          timestampCol: 'time',
          dataCol: 'val',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('(SELECT time, val FROM t)'),
        }),
      );
    });

    it('should include idCols if provided', async () => {
      mockQuery.mockResolvedValue([[]]);

      await queryTools.forecast(
        {
          projectId: 'project',
          historyData: 't',
          timestampCol: 'time',
          dataCol: 'val',
          idCols: ['id1', 'id2'],
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("id_cols => ['id1', 'id2']"),
        }),
      );
    });

    it('should fail if idCols contains non-strings', async () => {
      const result = await queryTools.forecast(
        {
          projectId: 'project',
          historyData: 't',
          timestampCol: 'time',
          dataCol: 'val',
          idCols: ['id1', 123 as any],
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toBe(
        'All elements in idCols must be strings.',
      );
    });
  });

  describe('analyzeContribution', () => {
    it('should create model and get insights successfully', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 'dataset.table',
          contributionMetric: 'metric',
          dimensionIdCols: ['dim1', 'dim2'],
          isTestCol: 'is_test',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenCalledTimes(2);
      // Verify create model query
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining(
            'CREATE TEMP MODEL contribution_analysis_model_mocked_uuid_123',
          ),
        }),
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining(
            "DIMENSION_ID_COLS = ['dim1', 'dim2']",
          ),
        }),
      );
      // Verify get insights query
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: expect.stringContaining(
            'SELECT * FROM ML.GET_INSIGHTS(MODEL contribution_analysis_model_mocked_uuid_123)',
          ),
        }),
      );
    });

    it('should fail if dimensionIdCols contains non-strings', async () => {
      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 't',
          contributionMetric: 'm',
          dimensionIdCols: ['d1', 123 as any],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toBe(
        'All elements in dimensionIdCols must be strings.',
      );
    });

    it('should fail if pruningMethod is invalid', async () => {
      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 't',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
          pruningMethod: 'INVALID_PRUNING',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toBe(
        'Invalid pruningMethod: INVALID_PRUNING',
      );
    });

    it('should fail if writeMode is BLOCKED', async () => {
      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 't',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.BLOCKED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'analyzeContribution is not allowed in this session.',
      );
    });

    it('should handle inputData as query', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 'SELECT * FROM t',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining('AS (SELECT * FROM t)'),
        }),
      );
    });

    it('should return error if model creation fails', async () => {
      setupProtectedModeMocks();
      mockQuery.mockRejectedValueOnce(new Error('Model creation failed'));

      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 'dataset.table',
          contributionMetric: 'metric',
          dimensionIdCols: ['dim1'],
          isTestCol: 'is_test',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain('Model creation failed');
    });

    it('should use default config if toolConfig is undefined and fail because BLOCKED', async () => {
      const result = await queryTools.analyzeContribution(
        {
          projectId: 'project',
          inputData: 'dataset.table',
          contributionMetric: 'metric',
          dimensionIdCols: ['dim1'],
          isTestCol: 'is_test',
        },
        undefined,
        undefined, // toolConfig is undefined
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'analyzeContribution is not allowed in this session.',
      );
    });
  });

  describe('detectAnomalies', () => {
    it('should create model and detect anomalies successfully', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 'dataset.table',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining(
            'CREATE TEMP MODEL detect_anomalies_model_mocked_uuid_123',
          ),
        }),
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: expect.stringContaining(
            'SELECT * FROM ML.DETECT_ANOMALIES(MODEL detect_anomalies_model_mocked_uuid_123',
          ),
        }),
      );
    });

    it('should include targetData if provided', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
          targetData: 'dataset.target_table',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: expect.stringContaining(
            '(SELECT * FROM `dataset.target_table`)',
          ),
        }),
      );
    });

    it('should include timesSeriesIdCols if provided', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
          timesSeriesIdCols: ['id1'],
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining("TIME_SERIES_ID_COL = ['id1']"),
        }),
      );
    });

    it('should fail if timesSeriesIdCols contains non-strings', async () => {
      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
          timesSeriesIdCols: ['id1', 123 as any],
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toBe(
        'All elements in timesSeriesIdCols must be strings.',
      );
    });

    it('should fail if writeMode is BLOCKED', async () => {
      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
        },
        undefined,
        {writeMode: WriteMode.BLOCKED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'anomaly detection is not allowed in this session.',
      );
    });

    it('should use default config if toolConfig is undefined and fail because BLOCKED', async () => {
      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
        },
        undefined,
        undefined, // toolConfig is undefined
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain(
        'anomaly detection is not allowed in this session.',
      );
    });

    it('should return error if model creation fails', async () => {
      setupProtectedModeMocks();
      mockQuery.mockRejectedValueOnce(new Error('Model creation failed'));

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 'dataset.table',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('ERROR');
      expect(result.error_details).toContain('Model creation failed');
    });

    it('should accept credentialsConfig and historyData as query', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 'SELECT time, val FROM t',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
        },
        {credentials: {token: 'token'}},
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          query: expect.stringContaining('(SELECT time, val FROM t)'),
        }),
      );
    });

    it('should handle targetData as query', async () => {
      setupProtectedModeMocks();
      mockQuery.mockResolvedValue([[]]);

      const result = await queryTools.detectAnomalies(
        {
          projectId: 'project',
          historyData: 't1',
          timesSeriesTimestampCol: 'time',
          timesSeriesDataCol: 'val',
          targetData: 'SELECT time, val FROM t2',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        context,
      );

      expect(result.status).toBe('SUCCESS');
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: expect.stringContaining('(SELECT time, val FROM t2)'),
        }),
      );
    });
  });

  it('should use default config if toolConfig is undefined in executeSql', async () => {
    mockCreateQueryJob.mockResolvedValue([
      {
        metadata: {
          statistics: {query: {statementType: 'SELECT'}},
        },
      },
    ]);
    mockQuery.mockResolvedValue([[{col: 1}]]);

    const result = await queryTools.executeSql(
      {projectId: 'project', query: 'SELECT 1'},
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.rows).toEqual([{col: 1}]);
  });

  it('should apply jobLabels from config in executeSql', async () => {
    mockCreateQueryJob.mockResolvedValue([
      {
        metadata: {
          statistics: {query: {statementType: 'SELECT'}},
        },
      },
    ]);
    mockQuery.mockResolvedValue([[]]);

    await queryTools.executeSql(
      {projectId: 'project', query: 'SELECT 1'},
      undefined,
      {
        writeMode: WriteMode.BLOCKED,
        jobLabels: {'my-label': 'my-value'},
      },
      context,
    );

    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({
          'my-label': 'my-value',
          'adk-bigquery-tool': 'execute_sql',
        }),
      }),
    );
  });

  it('should handle non-Error exceptions in executeSql', async () => {
    mockQuery.mockRejectedValueOnce('String Query Failed');

    const result = await queryTools.executeSql(
      {projectId: 'project', query: 'SELECT 1'},
      undefined,
      {writeMode: WriteMode.ALLOWED},
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe('String Query Failed');
  });

  it('should handle string exceptions in analyzeContribution catch block', async () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw 'Proxy String Error';
        },
      },
    );

    const result = await queryTools.analyzeContribution(
      {
        projectId: 'project',
        inputData: 't',
        contributionMetric: 'm',
        dimensionIdCols: ['d1'],
        isTestCol: 't',
      },
      undefined,
      throwingProxy as any,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain(
      'Error during analyzeContribution: Proxy String Error',
    );
  });

  it('should handle string exceptions in detectAnomalies catch block', async () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw 'Proxy String Error';
        },
      },
    );

    const result = await queryTools.detectAnomalies(
      {
        projectId: 'project',
        historyData: 't',
        timesSeriesTimestampCol: 'time',
        timesSeriesDataCol: 'val',
      },
      undefined,
      throwingProxy as any,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain(
      'Error during anomaly detection: Proxy String Error',
    );
  });
});
