/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery} from '@google-cloud/bigquery';
import {Context} from '@google/adk/agents/context.js';
import {getBigQueryClient} from '@google/adk/tools/bigquery/client_helper.js';
import {
  BigQueryToolConfig,
  WriteMode,
} from '@google/adk/tools/bigquery/config.js';
import {
  analyzeContribution,
  detectAnomalies,
  executeSql,
  forecast,
} from '@google/adk/tools/bigquery/query_tools.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@google/adk/tools/bigquery/client_helper.js', () => ({
  getBigQueryClient: vi.fn(),
}));

vi.mock('@google/adk/utils/env_aware_utils.js', async () => {
  const actual = await vi.importActual<
    typeof import('@google/adk/utils/env_aware_utils.js')
  >('@google/adk/utils/env_aware_utils.js');
  return {
    ...actual,
    randomUUID: () => '12345678-1234-4123-8123-1234567890ab',
  };
});

function createMockContext(store = new Map<string, unknown>()) {
  return {
    state: {
      get: (key: string) => store.get(key),
      set: (key: string, val: unknown) => store.set(key, val),
    },
  } as unknown as Context;
}

describe('query_tools', () => {
  const mockClient = {
    query: vi.fn(),
    createQueryJob: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBigQueryClient).mockResolvedValue(
      mockClient as unknown as BigQuery,
    );
  });

  describe('executeSql', () => {
    it('should execute SELECT query successfully in ALLOWED mode', async () => {
      const mockRows = [{num: 123}];
      mockClient.query.mockResolvedValue([mockRows]);

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(result).toEqual({status: 'SUCCESS', rows: mockRows});
      expect(mockClient.query).toHaveBeenCalledWith({
        query: 'SELECT 1',
        connectionProperties: [],
        labels: {'adk-bigquery-tool': 'execute_sql'},
      });
    });

    it('should restrict project if computeProjectId is set', async () => {
      const result = await executeSql(
        {projectId: 'wrong-project', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED, computeProjectId: 'right-project'},
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Cannot execute query in the project wrong-project, as the tool is restricted to execute queries only in the project right-project.',
      });
    });

    it('should block non-SELECT in BLOCKED mode', async () => {
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'UPDATE'}},
          },
        },
      ]);

      const result = await executeSql(
        {projectId: 'p', query: 'UPDATE table SET x = 1'},
        undefined,
        {writeMode: WriteMode.BLOCKED},
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Read-only mode only supports SELECT statements.',
      });
      expect(mockClient.createQueryJob).toHaveBeenCalledWith({
        query: 'UPDATE table SET x = 1',
        dryRun: true,
        labels: {'adk-bigquery-tool': 'execute_sql'},
      });
    });

    it('should allow SELECT in BLOCKED mode', async () => {
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'SELECT'}},
          },
        },
      ]);
      const mockRows = [{num: 123}];
      mockClient.query.mockResolvedValue([mockRows]);

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        undefined,
      );

      expect(result).toEqual({status: 'SUCCESS', rows: mockRows});
    });

    it('should handle PROTECTED mode - session creation and validation', async () => {
      const mockContext = {
        state: {
          get: vi.fn().mockReturnValue(undefined), // No session yet
          set: vi.fn(),
        },
      } as unknown as Context;

      mockClient.createQueryJob
        .mockResolvedValueOnce([
          {
            metadata: {
              statistics: {query: {sessionInfo: {sessionId: 's1'}}},
              configuration: {query: {destinationTable: {datasetId: 'd1'}}},
            },
          },
        ]) // Session creation dry run
        .mockResolvedValueOnce([
          {
            metadata: {
              statistics: {query: {statementType: 'CREATE_TABLE'}},
              configuration: {query: {destinationTable: {datasetId: 'd1'}}}, // Writing to anonymous dataset
            },
          },
        ]); // Query dry run

      const mockRows: unknown[] = [];
      mockClient.query.mockResolvedValue([mockRows]);

      const result = await executeSql(
        {projectId: 'p', query: 'CREATE TEMP TABLE t AS SELECT 1'},
        undefined,
        {writeMode: WriteMode.PROTECTED},
        mockContext,
      );

      expect(result).toEqual({status: 'SUCCESS', rows: mockRows});
      expect(mockContext.state.set).toHaveBeenCalledWith(
        'bigquery_session_info',
        ['s1', 'd1'],
      );
      expect(mockClient.query).toHaveBeenCalledWith({
        query: 'CREATE TEMP TABLE t AS SELECT 1',
        connectionProperties: [{key: 'session_id', value: 's1'}],
        labels: {'adk-bigquery-tool': 'execute_sql'},
      });
    });

    it('should block non-SELECT writing to other datasets in PROTECTED mode', async () => {
      const mockContext = {
        state: {
          get: vi.fn().mockReturnValue(['s1', 'd1']), // Existing session
          set: vi.fn(),
        },
      } as unknown as Context;

      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {statementType: 'CREATE_TABLE'}},
            configuration: {
              query: {destinationTable: {datasetId: 'other_dataset'}},
            },
          },
        },
      ]);

      const result = await executeSql(
        {projectId: 'p', query: 'CREATE TABLE other_dataset.t AS SELECT 1'},
        undefined,
        {writeMode: WriteMode.PROTECTED},
        mockContext,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
      });
    });

    it('should handle dryRun option', async () => {
      const mockMetadata = {jobReference: {jobId: 'j1'}};
      mockClient.createQueryJob.mockResolvedValue([{metadata: mockMetadata}]);

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1', dryRun: true},
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(result).toEqual({
        status: 'SUCCESS',
        dry_run_info: mockMetadata,
      });
    });

    it('should handle errors and return error details', async () => {
      mockClient.query.mockRejectedValue(new Error('Query failed'));

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Query failed',
      });
    });

    it('should format rows and handle non-JSON serializable values', async () => {
      const bigIntVal = BigInt(9007199254740991);
      const mockRows = [{num: 123, big: bigIntVal}];
      mockClient.query.mockResolvedValue([mockRows]);

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(result).toEqual({
        status: 'SUCCESS',
        rows: [{num: 123, big: '9007199254740991'}],
      });
    });

    it('should indicate likely truncation if maxQueryResultRows is met', async () => {
      const mockRows = [{num: 1}, {num: 2}];
      mockClient.query.mockResolvedValue([mockRows]);

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED, maxQueryResultRows: 2},
      );

      expect(result).toEqual({
        status: 'SUCCESS',
        rows: mockRows,
        result_is_likely_truncated: true,
      });
    });

    it('should pass maximumBytesBilled to query options', async () => {
      mockClient.query.mockResolvedValue([[]]);

      await executeSql({projectId: 'p', query: 'SELECT 1'}, undefined, {
        writeMode: WriteMode.ALLOWED,
        maximumBytesBilled: 20000000,
      });

      expect(mockClient.query).toHaveBeenCalledWith({
        query: 'SELECT 1',
        connectionProperties: [],
        labels: {'adk-bigquery-tool': 'execute_sql'},
        maximumBytesBilled: '20000000',
      });
    });

    it('should pass applicationName to job labels', async () => {
      mockClient.query.mockResolvedValue([[]]);

      await executeSql({projectId: 'p', query: 'SELECT 1'}, undefined, {
        writeMode: WriteMode.ALLOWED,
        applicationName: 'my-app',
      });

      expect(mockClient.query).toHaveBeenCalledWith({
        query: 'SELECT 1',
        connectionProperties: [],
        labels: {
          'adk-bigquery-tool': 'execute_sql',
          'adk-bigquery-application-name': 'my-app',
        },
      });
    });

    it('should pass jobLabels to query options', async () => {
      mockClient.query.mockResolvedValue([[]]);

      await executeSql({projectId: 'p', query: 'SELECT 1'}, undefined, {
        writeMode: WriteMode.ALLOWED,
        jobLabels: {label1: 'val1'},
      });

      expect(mockClient.query).toHaveBeenCalledWith({
        query: 'SELECT 1',
        connectionProperties: [],
        labels: {
          'adk-bigquery-tool': 'execute_sql',
          'label1': 'val1',
        },
      });
    });

    it('should handle non-Error errors in executeSql catch block', async () => {
      mockClient.query.mockRejectedValue('String Error');

      const result = await executeSql(
        {projectId: 'p', query: 'SELECT 1'},
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });

    it('should fail if session creation returns missing session info in PROTECTED mode', async () => {
      const mockContext = {
        state: {
          get: vi.fn().mockReturnValue(undefined),
          set: vi.fn(),
        },
      } as unknown as Context;

      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {query: {sessionInfo: {}}},
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ]);

      const result = await executeSql(
        {projectId: 'p', query: 'CREATE TEMP TABLE t AS SELECT 1'},
        undefined,
        {writeMode: WriteMode.PROTECTED},
        mockContext,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to create BigQuery session.',
      });
    });
  });

  describe('forecast', () => {
    it('should generate correct SQL without idCols', async () => {
      mockClient.query.mockResolvedValue([[]]);

      await forecast(
        {
          projectId: 'p',
          historyData: 'my_table',
          timestampCol: 'col_t',
          dataCol: 'col_d',
          horizon: 5,
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.any(String),
        }),
      );
      const calledQuery = mockClient.query.mock.calls[0][0].query;
      expect(calledQuery).toContain('TABLE `my_table`');
      expect(calledQuery).toContain("data_col => 'col_d'");
      expect(calledQuery).toContain("timestamp_col => 'col_t'");
      expect(calledQuery).toContain("model => 'TimesFM 2.0'");
      expect(calledQuery).toContain('horizon => 5');
      expect(calledQuery).toContain('confidence_level => 0.95');
    });

    it('should generate correct SQL with idCols', async () => {
      mockClient.query.mockResolvedValue([[]]);

      await forecast(
        {
          projectId: 'p',
          historyData: 'SELECT * FROM t',
          timestampCol: 'col_t',
          dataCol: 'col_d',
          idCols: ['id1', 'id2'],
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
      );

      const calledQuery = mockClient.query.mock.calls[0][0].query;
      expect(calledQuery).toContain('(SELECT * FROM t)');
      expect(calledQuery).toContain("id_cols => ['id1', 'id2']");
    });

    it('should return error if idCols contains non-string', async () => {
      const result = await forecast({
        projectId: 'p',
        historyData: 'my_table',
        timestampCol: 't',
        dataCol: 'd',
        idCols: ['id1', 123 as unknown as string],
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'All elements in idCols must be strings.',
      });
    });
  });

  describe('analyzeContribution', () => {
    it('should generate correct SQL and handle temp model', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockImplementation(
        async (options: {createSession?: boolean}) => {
          if (options.createSession) {
            return [
              {
                metadata: {
                  statistics: {query: {sessionInfo: {sessionId: 's1'}}},
                  configuration: {query: {destinationTable: {datasetId: 'd1'}}},
                },
              },
            ];
          }
          return [
            {
              metadata: {
                statistics: {query: {statementType: 'CREATE_TABLE'}},
                configuration: {query: {destinationTable: {datasetId: 'd1'}}},
              },
            },
          ];
        },
      );

      const store = new Map();
      const mockContext = createMockContext(store);

      await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'my_table',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED}, // Pass ALLOWED so it changes to PROTECTED
        mockContext,
      );

      expect(mockClient.query).toHaveBeenCalledTimes(2);
      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain(
        'CREATE TEMP MODEL contribution_analysis_model_12345678_1234_4123_8123_1234567890ab',
      );
      expect(createModelQuery).toContain(
        "MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'",
      );
      expect(createModelQuery).toContain("CONTRIBUTION_METRIC = 'm'");
      expect(createModelQuery).toContain("IS_TEST_COL = 't'");
      expect(createModelQuery).toContain("DIMENSION_ID_COLS = ['d1']");
      expect(createModelQuery).toContain('SELECT * FROM `my_table`');

      const getInsightsQuery = mockClient.query.mock.calls[1][0].query;
      expect(getInsightsQuery).toContain(
        'SELECT * FROM ML.GET_INSIGHTS(MODEL contribution_analysis_model_12345678_1234_4123_8123_1234567890ab)',
      );
    });

    it('should return error if dimensionIdCols contains non-string', async () => {
      const result = await analyzeContribution({
        projectId: 'p',
        inputData: 'my_table',
        contributionMetric: 'm',
        dimensionIdCols: ['d1', 123 as unknown as string],
        isTestCol: 't',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'All elements in dimensionIdCols must be strings.',
      });
    });

    it('should return error if pruningMethod is invalid', async () => {
      const result = await analyzeContribution({
        projectId: 'p',
        inputData: 'my_table',
        contributionMetric: 'm',
        dimensionIdCols: ['d1'],
        isTestCol: 't',
        pruningMethod: 'invalid',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Invalid pruningMethod: invalid',
      });
    });

    it('should block if writeMode is BLOCKED', async () => {
      const result = await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'my_table',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        undefined,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Error during analyzeContribution: analyzeContribution is not allowed in this session.',
      });
    });

    it('should return error if CREATE TEMP MODEL fails', async () => {
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {
              query: {
                sessionInfo: {sessionId: 's1'},
                statementType: 'CREATE_TABLE',
              },
            },
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ]);
      mockClient.query.mockRejectedValue(new Error('Model creation failed'));

      const store = new Map();
      const mockContext = createMockContext(store);

      const result = await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'my_table',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Model creation failed',
      });
    });

    it('should generate correct SQL with SELECT query inputData', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {
              query: {
                sessionInfo: {sessionId: 's1'},
                statementType: 'CREATE_TABLE',
              },
            },
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ]);

      const store = new Map();
      const mockContext = createMockContext(store);

      await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'SELECT * FROM input',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain('AS (SELECT * FROM input)');
    });

    it('should generate correct SQL with WITH query inputData', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {
              query: {
                sessionInfo: {sessionId: 's1'},
                statementType: 'CREATE_TABLE',
              },
            },
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ]);

      const store = new Map();
      const mockContext = createMockContext(store);

      await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'WITH t AS (SELECT 1) SELECT * FROM t',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain(
        'AS (WITH t AS (SELECT 1) SELECT * FROM t)',
      );
    });

    it('should handle non-Error errors in analyzeContribution catch block', async () => {
      const badConfig = {
        get writeMode() {
          throw 'String Error';
        },
      } as unknown as BigQueryToolConfig;

      const result = await analyzeContribution(
        {
          projectId: 'p',
          inputData: 'my_table',
          contributionMetric: 'm',
          dimensionIdCols: ['d1'],
          isTestCol: 't',
        },
        undefined,
        badConfig,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Error during analyzeContribution: String Error',
      });
    });
  });

  describe('detectAnomalies', () => {
    it('should generate correct SQL and handle temp model', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockImplementation(
        async (options: {createSession?: boolean}) => {
          if (options.createSession) {
            return [
              {
                metadata: {
                  statistics: {query: {sessionInfo: {sessionId: 's1'}}},
                  configuration: {query: {destinationTable: {datasetId: 'd1'}}},
                },
              },
            ];
          }
          return [
            {
              metadata: {
                statistics: {query: {statementType: 'CREATE_TABLE'}},
                configuration: {query: {destinationTable: {datasetId: 'd1'}}},
              },
            },
          ];
        },
      );

      const store = new Map();
      const mockContext = createMockContext(store);

      await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'my_table',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      expect(mockClient.query).toHaveBeenCalledTimes(2);
      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain(
        'CREATE TEMP MODEL detect_anomalies_model_12345678_1234_4123_8123_1234567890ab',
      );
      expect(createModelQuery).toContain("MODEL_TYPE = 'ARIMA_PLUS'");
      expect(createModelQuery).toContain("TIME_SERIES_TIMESTAMP_COL = 't'");
      expect(createModelQuery).toContain("TIME_SERIES_DATA_COL = 'd'");
      expect(createModelQuery).toContain('HORIZON = 1000');

      const detectQuery = mockClient.query.mock.calls[1][0].query;
      expect(detectQuery).toContain(
        'SELECT * FROM ML.DETECT_ANOMALIES(MODEL detect_anomalies_model_12345678_1234_4123_8123_1234567890ab, STRUCT(0.95 AS anomaly_prob_threshold))',
      );
    });

    it('should generate correct SQL with idCols and targetData (TABLE inputs)', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockImplementation(
        async (options: {createSession?: boolean}) => {
          if (options.createSession) {
            return [
              {
                metadata: {
                  statistics: {query: {sessionInfo: {sessionId: 's1'}}},
                  configuration: {query: {destinationTable: {datasetId: 'd1'}}},
                },
              },
            ];
          }
          return [
            {
              metadata: {
                statistics: {query: {statementType: 'CREATE_TABLE'}},
                configuration: {query: {destinationTable: {datasetId: 'd1'}}},
              },
            },
          ];
        },
      );

      const store = new Map();
      const mockContext = createMockContext(store);

      await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'my_table',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
          timesSeriesIdCols: ['id1'],
          targetData: 'target_table',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain("TIME_SERIES_ID_COL = ['id1']");
      expect(createModelQuery).toContain('SELECT * FROM `my_table`');

      const detectQuery = mockClient.query.mock.calls[1][0].query;
      expect(detectQuery).toContain(
        'SELECT * FROM ML.DETECT_ANOMALIES(MODEL detect_anomalies_model_12345678_1234_4123_8123_1234567890ab, STRUCT(0.95 AS anomaly_prob_threshold), (SELECT * FROM `target_table`)) ORDER BY id1, t',
      );
    });

    it('should generate correct SQL with SELECT query inputs', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockImplementation(
        async (options: {createSession?: boolean}) => {
          if (options.createSession) {
            return [
              {
                metadata: {
                  statistics: {query: {sessionInfo: {sessionId: 's1'}}},
                  configuration: {query: {destinationTable: {datasetId: 'd1'}}},
                },
              },
            ];
          }
          return [
            {
              metadata: {
                statistics: {query: {statementType: 'CREATE_TABLE'}},
                configuration: {query: {destinationTable: {datasetId: 'd1'}}},
              },
            },
          ];
        },
      );

      const store = new Map();
      const mockContext = createMockContext(store);

      await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'SELECT * FROM history',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
          timesSeriesIdCols: ['id1'],
          targetData: 'SELECT * FROM target',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain('AS (SELECT * FROM history)');

      const detectQuery = mockClient.query.mock.calls[1][0].query;
      expect(detectQuery).toContain(
        'SELECT * FROM ML.DETECT_ANOMALIES(MODEL detect_anomalies_model_12345678_1234_4123_8123_1234567890ab, STRUCT(0.95 AS anomaly_prob_threshold), (SELECT * FROM target)) ORDER BY id1, t',
      );
    });

    it('should generate correct SQL with WITH query inputs', async () => {
      mockClient.query.mockResolvedValue([[]]);
      mockClient.createQueryJob.mockImplementation(
        async (options: {createSession?: boolean}) => {
          if (options.createSession) {
            return [
              {
                metadata: {
                  statistics: {query: {sessionInfo: {sessionId: 's1'}}},
                  configuration: {query: {destinationTable: {datasetId: 'd1'}}},
                },
              },
            ];
          }
          return [
            {
              metadata: {
                statistics: {query: {statementType: 'CREATE_TABLE'}},
                configuration: {query: {destinationTable: {datasetId: 'd1'}}},
              },
            },
          ];
        },
      );

      const store = new Map();
      const mockContext = createMockContext(store);

      await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'WITH h AS (SELECT 1) SELECT * FROM h',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
          timesSeriesIdCols: ['id1'],
          targetData: 'WITH t AS (SELECT 1) SELECT * FROM t',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      const createModelQuery = mockClient.query.mock.calls[0][0].query;
      expect(createModelQuery).toContain(
        'AS (WITH h AS (SELECT 1) SELECT * FROM h)',
      );

      const detectQuery = mockClient.query.mock.calls[1][0].query;
      expect(detectQuery).toContain(
        'SELECT * FROM ML.DETECT_ANOMALIES(MODEL detect_anomalies_model_12345678_1234_4123_8123_1234567890ab, STRUCT(0.95 AS anomaly_prob_threshold), (WITH t AS (SELECT 1) SELECT * FROM t)) ORDER BY id1, t',
      );
    });

    it('should return error if timesSeriesIdCols contains non-string', async () => {
      const result = await detectAnomalies({
        projectId: 'p',
        historyData: 'my_table',
        timesSeriesTimestampCol: 't',
        timesSeriesDataCol: 'd',
        timesSeriesIdCols: ['id1', 123 as unknown as string],
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'All elements in timesSeriesIdCols must be strings.',
      });
    });

    it('should block if writeMode is BLOCKED', async () => {
      const result = await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'my_table',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
        },
        undefined,
        undefined,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Error during anomaly detection: anomaly detection is not allowed in this session.',
      });
    });

    it('should return error if CREATE TEMP MODEL fails', async () => {
      mockClient.createQueryJob.mockResolvedValue([
        {
          metadata: {
            statistics: {
              query: {
                sessionInfo: {sessionId: 's1'},
                statementType: 'CREATE_TABLE',
              },
            },
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ]);
      mockClient.query.mockRejectedValue(new Error('Model creation failed'));

      const store = new Map();
      const mockContext = createMockContext(store);

      const result = await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'my_table',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
        },
        undefined,
        {writeMode: WriteMode.ALLOWED},
        mockContext,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Model creation failed',
      });
    });

    it('should handle non-Error errors in catch block', async () => {
      const badConfig = {
        get writeMode() {
          throw 'String Error';
        },
      } as unknown as BigQueryToolConfig;

      const result = await detectAnomalies(
        {
          projectId: 'p',
          historyData: 'my_table',
          timesSeriesTimestampCol: 't',
          timesSeriesDataCol: 'd',
        },
        undefined,
        badConfig,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Error during anomaly detection: String Error',
      });
    });
  });
});
