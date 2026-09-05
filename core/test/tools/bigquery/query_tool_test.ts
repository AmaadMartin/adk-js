/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_query_tool.py`
 * (branch `main`).
 */

import {
  analyzeContribution,
  BIGQUERY_SESSION_INFO_KEY,
  BigQueryClientCache,
  BQ_USER_AGENT,
  createBigQueryToolConfig,
  detectAnomalies,
  executeSql,
  forecast,
  WriteMode,
  type BigQueryToolConfig,
  type BigQueryToolDeps,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {validateSubquery} from '../../../src/tools/bigquery/query_tool.js';
import {
  bigQueryState,
  resetBigQueryState,
  createToolContext as toolContext,
} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

/** Builds the deps a query tool runs with. */
function deps(config: BigQueryToolConfig = {}): BigQueryToolDeps {
  return {
    clients: new BigQueryClientCache(),
    settings: createBigQueryToolConfig(config),
  };
}

/** The arguments every `execute_sql` test starts from. */
const SELECT_QUERY = {
  project_id: 'test-project',
  query: 'SELECT * FROM `test-dataset.test-table`',
};

beforeEach(() => {
  resetBigQueryState();
});

describe('executeSql', () => {
  it.each([
    {
      writeMode: WriteMode.BLOCKED,
      // One read-only gate dry run, then the query itself.
      replies: [{statementType: 'SELECT'}, {rows: [{island: 'Dream'}]}],
    },
    {
      writeMode: WriteMode.PROTECTED,
      // A session opener, the gate dry run, then the query itself.
      replies: [
        {sessionId: 'sess-1', destinationDatasetId: '_anon'},
        {statementType: 'SELECT'},
        {rows: [{island: 'Dream'}]},
      ],
    },
    {
      // The allowed mode runs no gate, so the query is the only job.
      writeMode: WriteMode.ALLOWED,
      replies: [{rows: [{island: 'Dream'}]}],
    },
  ])(
    'test_execute_sql_select_stmt ($writeMode)',
    async ({writeMode, replies}) => {
      bigQueryState.replies = replies;

      const result = await executeSql(
        SELECT_QUERY,
        deps({writeMode}),
        toolContext(),
      );

      expect(result).toEqual({status: 'SUCCESS', rows: [{island: 'Dream'}]});
    },
  );

  it.each([
    {
      query: 'CREATE TABLE t AS SELECT 1',
      statementType: 'CREATE_TABLE_AS_SELECT',
    },
    {query: 'DROP TABLE t', statementType: 'DROP_TABLE'},
    {query: 'UPDATE t SET a = 1 WHERE TRUE', statementType: 'UPDATE'},
  ])(
    'test_execute_sql_non_select_stmt_write_blocked ($statementType)',
    async ({query, statementType}) => {
      bigQueryState.replies = [{statementType}];

      const result = await executeSql(
        {project_id: 'test-project', query},
        deps({writeMode: WriteMode.BLOCKED}),
        toolContext(),
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Read-only mode only supports SELECT statements.',
      });
    },
  );

  it('test_execute_sql_non_select_stmt_write_allowed', async () => {
    bigQueryState.replies = [{statementType: 'DROP_TABLE', rows: []}];

    const result = await executeSql(
      {project_id: 'test-project', query: 'DROP TABLE t'},
      deps({writeMode: WriteMode.ALLOWED}),
      toolContext(),
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
    // The allowed mode runs no gate, so the query is the only job.
    expect(bigQueryState.queryJobs).toHaveLength(1);
  });

  it('test_execute_sql_non_select_stmt_write_protected', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_anon',
      },
      {statementType: 'CREATE_TABLE_AS_SELECT', destinationDatasetId: '_anon'},
      {statementType: 'CREATE_TABLE_AS_SELECT', rows: []},
    ];

    const result = await executeSql(
      {project_id: 'test-project', query: 'CREATE TEMP TABLE t AS SELECT 1'},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
  });

  it('test_execute_sql_non_select_stmt_write_protected_persistent_target', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_anon',
      },
      {
        statementType: 'CREATE_TABLE_AS_SELECT',
        destinationDatasetId: 'permanent_dataset',
      },
    ];

    const result = await executeSql(
      {project_id: 'test-project', query: 'CREATE TABLE d.t AS SELECT 1'},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details:
        'Protected write mode only supports SELECT statements, or write' +
        ' operations in the anonymous dataset of a BigQuery session.',
    });
  });

  it('opens one BigQuery session and remembers it in the tool context', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_anon',
      },
      {statementType: 'SELECT', rows: []},
    ];
    const context = toolContext();
    const settings = deps({writeMode: WriteMode.PROTECTED});

    await executeSql(SELECT_QUERY, settings, context);
    expect(context.state.get(BIGQUERY_SESSION_INFO_KEY)).toEqual([
      'sess-1',
      '_anon',
    ]);

    const jobsAfterFirstCall = bigQueryState.queryJobs.length;
    await executeSql(SELECT_QUERY, settings, context);

    // The second call reuses the session, so it opens no new one: one dry run
    // plus one execution, against three jobs for the first call.
    expect(bigQueryState.queryJobs).toHaveLength(jobsAfterFirstCall + 2);
    expect(bigQueryState.queryJobs[3].connectionProperties).toEqual([
      {key: 'session_id', value: 'sess-1'},
    ]);
  });

  it('opens a session per call when there is no tool context', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_anon',
      },
    ];
    const settings = deps({writeMode: WriteMode.PROTECTED});

    await executeSql(SELECT_QUERY, settings);
    await executeSql(SELECT_QUERY, settings);

    const sessionOpeners = bigQueryState.queryJobs.filter(
      (job) => job.createSession,
    );
    expect(sessionOpeners).toHaveLength(2);
  });

  it('test_execute_sql_dry_run_true', async () => {
    bigQueryState.replies = [{statementType: 'SELECT'}];

    const result = await executeSql(
      {...SELECT_QUERY, dry_run: true},
      deps(),
      toolContext(),
    );

    expect(result).toMatchObject({status: 'SUCCESS'});
    expect(result).toHaveProperty('dry_run_info');
  });

  it('test_execute_sql_unexpected_project_id', async () => {
    const result = await executeSql(
      SELECT_QUERY,
      deps({computeProjectId: 'other-project'}),
      toolContext(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details:
        'Cannot execute query in the project test-project, as the tool is' +
        ' restricted to execute queries only in the project other-project.',
    });
    expect(bigQueryState.queryJobs).toHaveLength(0);
  });

  it('runs when the query project matches the compute project', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    const result = await executeSql(
      SELECT_QUERY,
      deps({computeProjectId: 'test-project'}),
      toolContext(),
    );

    expect(result).toMatchObject({status: 'SUCCESS'});
  });

  it('test_execute_sql_max_rows_config', async () => {
    bigQueryState.replies = [
      {statementType: 'SELECT', rows: [{a: 1}, {a: 2}, {a: 3}]},
    ];

    const result = await executeSql(
      SELECT_QUERY,
      deps({maxQueryResultRows: 2}),
      toolContext(),
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{a: 1}, {a: 2}],
      result_is_likely_truncated: true,
    });
  });

  it('test_execute_sql_no_truncation', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: [{a: 1}]}];

    const result = await executeSql(
      SELECT_QUERY,
      deps({maxQueryResultRows: 2}),
      toolContext(),
    );

    expect(result).toEqual({status: 'SUCCESS', rows: [{a: 1}]});
  });

  it('test_execute_sql_maximum_bytes_billed_config', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(
      SELECT_QUERY,
      deps({maximumBytesBilled: 10_485_760}),
      toolContext(),
    );

    const executionJob = bigQueryState.queryJobs.at(-1);
    expect(executionJob?.maximumBytesBilled).toBe('10485760');
  });

  it('leaves maximumBytesBilled unset when the config does not cap it', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(SELECT_QUERY, deps(), toolContext());

    expect(bigQueryState.queryJobs.at(-1)?.maximumBytesBilled).toBeUndefined();
  });

  it('test_execute_sql_result_dtype', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        rows: [{count: 1, name: 'a', flag: true, missing: null}],
      },
    ];

    const result = await executeSql(SELECT_QUERY, deps(), toolContext());

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{count: 1, name: 'a', flag: true, missing: null}],
    });
  });

  it('test_execute_sql_result_dtype_circular_reference', async () => {
    const circular: Record<string, unknown> = {name: 'loop'};
    circular['self'] = circular;
    bigQueryState.replies = [
      {statementType: 'SELECT', rows: [{value: circular, plain: 1}]},
    ];

    const result = await executeSql(SELECT_QUERY, deps(), toolContext());

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{value: '[object Object]', plain: 1}],
    });
  });

  it('refuses a query BigQuery reported no statement type for', async () => {
    bigQueryState.replies = [{}];

    await expect(
      executeSql(SELECT_QUERY, deps(), toolContext()),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
  });

  it('returns the failure envelope when BigQuery refuses the query', async () => {
    bigQueryState.replies = [{throws: new Error('Syntax error near FROM')}];

    await expect(
      executeSql(SELECT_QUERY, deps(), toolContext()),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Syntax error near FROM',
    });
  });
});

describe('job labels', () => {
  it('test_execute_sql_bq_client_creation', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(
      SELECT_QUERY,
      deps({applicationName: 'my-agent', location: 'EU'}),
      toolContext(),
    );

    expect(bigQueryState.clientOptions[0]).toMatchObject({
      projectId: 'test-project',
      location: 'EU',
      userAgent: `${BQ_USER_AGENT} my-agent execute_sql`,
    });
  });

  it.each([
    {
      id: 'forecast',
      call: (toolDeps: BigQueryToolDeps) =>
        forecast(
          {
            project_id: 'test-project',
            history_data: 'd.t',
            timestamp_col: 'ts',
            data_col: 'value',
          },
          toolDeps,
          toolContext(),
        ),
    },
    {
      id: 'analyze_contribution',
      call: (toolDeps: BigQueryToolDeps) =>
        analyzeContribution(
          {
            project_id: 'test-project',
            input_data: 'd.t',
            contribution_metric: 'SUM(m)',
            dimension_id_cols: ['dim'],
            is_test_col: 'is_test',
          },
          toolDeps,
          toolContext(),
        ),
    },
    {
      id: 'detect_anomalies',
      call: (toolDeps: BigQueryToolDeps) =>
        detectAnomalies(
          {
            project_id: 'test-project',
            history_data: 'd.t',
            times_series_timestamp_col: 'ts',
            times_series_data_col: 'value',
          },
          toolDeps,
          toolContext(),
        ),
    },
  ])('test_ml_tool_job_labels ($id)', async ({id, call}) => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await call(deps({writeMode: WriteMode.PROTECTED}));

    expect(bigQueryState.queryJobs[0].labels).toEqual({
      'adk-bigquery-tool': id,
    });
  });

  it('test_ml_tool_user_job_labels_augment_internal_labels', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await forecast(
      {
        project_id: 'test-project',
        history_data: 'd.t',
        timestamp_col: 'ts',
        data_col: 'value',
      },
      deps({jobLabels: {team: 'data'}, applicationName: 'my-agent'}),
      toolContext(),
    );

    expect(bigQueryState.queryJobs[0].labels).toEqual({
      'team': 'data',
      'adk-bigquery-tool': 'forecast',
      'adk-bigquery-application-name': 'my-agent',
    });
  });

  it('test_execute_sql_job_labels', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(SELECT_QUERY, deps(), toolContext());

    expect(bigQueryState.queryJobs[0].labels).toEqual({
      'adk-bigquery-tool': 'execute_sql',
    });
  });

  it('test_ml_tool_job_labels_w_application_name', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(
      SELECT_QUERY,
      deps({applicationName: 'my-agent'}),
      toolContext(),
    );

    expect(bigQueryState.queryJobs[0].labels).toEqual({
      'adk-bigquery-tool': 'execute_sql',
      'adk-bigquery-application-name': 'my-agent',
    });
  });

  it('test_execute_sql_user_job_labels_augment_internal_labels', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await executeSql(
      SELECT_QUERY,
      deps({jobLabels: {team: 'data'}, applicationName: 'my-agent'}),
      toolContext(),
    );

    expect(bigQueryState.queryJobs[0].labels).toEqual({
      'team': 'data',
      'adk-bigquery-tool': 'execute_sql',
      'adk-bigquery-application-name': 'my-agent',
    });
  });

  it('test_tool_call_doesnt_mutate_job_labels', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];
    const jobLabels = {team: 'data'};
    const toolDeps = deps({jobLabels});

    await executeSql(SELECT_QUERY, toolDeps, toolContext());

    expect(jobLabels).toEqual({team: 'data'});
    expect(toolDeps.settings.jobLabels).toEqual({team: 'data'});
  });

  it('test_tool_call_doesnt_change_global_settings', async () => {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_a',
      },
      {statementType: 'SELECT'},
      {statementType: 'SELECT', rows: []},
    ];
    const toolDeps = deps({writeMode: WriteMode.ALLOWED});
    const before = {...toolDeps.settings};

    await detectAnomalies(
      {
        project_id: 'test-project',
        history_data: 'test-dataset.test-table',
        times_series_timestamp_col: 'ts',
        times_series_data_col: 'value',
      },
      toolDeps,
      toolContext(),
    );

    expect(toolDeps.settings).toEqual(before);
    expect(toolDeps.settings.writeMode).toBe(WriteMode.ALLOWED);
  });
});

describe('validateSubquery', () => {
  it('test_validate_subquery_success', async () => {
    bigQueryState.replies = [{statementType: 'SELECT'}];

    await expect(
      validateSubquery('SELECT 1', deps(), 'test-project', 'forecast'),
    ).resolves.toBeUndefined();
  });

  it('test_validate_subquery_failure_non_select', async () => {
    bigQueryState.replies = [{statementType: 'DELETE'}];

    await expect(
      validateSubquery('DELETE FROM t', deps(), 'test-project', 'forecast'),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Subquery must be a SELECT statement.',
    });
  });

  it.each([400, 404])(
    'test_validate_subquery_exception_bad_request (%i)',
    async (code) => {
      bigQueryState.replies = [
        {throws: Object.assign(new Error('bad things'), {code})},
      ];

      await expect(
        validateSubquery('SELECT 1', deps(), 'test-project', 'forecast'),
      ).resolves.toEqual({
        status: 'ERROR',
        error_details: 'Invalid subquery: bad things',
      });
    },
  );

  it('test_validate_subquery_exception_generic', async () => {
    bigQueryState.replies = [
      {throws: Object.assign(new Error('server exploded'), {code: 500})},
    ];

    await expect(
      validateSubquery('SELECT 1', deps(), 'test-project', 'forecast'),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Subquery dry run validation failed: server exploded',
    });
  });

  it('reports an error whose code is not a status as a generic failure', async () => {
    bigQueryState.replies = [
      {
        throws: Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      },
    ];

    await expect(
      validateSubquery('SELECT 1', deps(), 'test-project', 'forecast'),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Subquery dry run validation failed: socket hang up',
    });
  });

  it('reports a thrown non-error as a generic validation failure', async () => {
    bigQueryState.replies = [{throws: 'string failure'}];

    await expect(
      validateSubquery('SELECT 1', deps(), 'test-project', 'forecast'),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Subquery dry run validation failed: string failure',
    });
  });
});

describe('forecast', () => {
  const baseInput = {
    project_id: 'test-project',
    history_data: 'test-dataset.test-table',
    timestamp_col: 'ts_col',
    data_col: 'data_col',
  };

  it('test_forecast_with_table_id', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await forecast(baseInput, deps(), toolContext());

    const query = bigQueryState.queryJobs.at(-1)?.query ?? '';
    expect(query).toContain('AI.FORECAST(');
    expect(query).toContain('TABLE `test-dataset.test-table`');
    expect(query).toContain("data_col => 'data_col'");
    expect(query).toContain("timestamp_col => 'ts_col'");
    expect(query).toContain("model => 'TimesFM 2.0'");
    expect(query).toContain('horizon => 10');
    expect(query).toContain('confidence_level => 0.95');
    expect(query).not.toContain('id_cols');
  });

  it('test_forecast_with_query_statement', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await forecast(
      {
        ...baseInput,
        history_data: 'SELECT * FROM `p.d.t`',
        id_cols: ['store_id'],
        horizon: 7,
      },
      deps(),
      toolContext(),
    );

    const query = bigQueryState.queryJobs.at(-1)?.query ?? '';
    expect(query).toContain('(SELECT * FROM `p.d.t`)');
    expect(query).toContain("id_cols => ['store_id']");
    expect(query).toContain('horizon => 7');
  });

  it('truncates a fractional horizon, as adk-python int() does', async () => {
    bigQueryState.replies = [{statementType: 'SELECT', rows: []}];

    await forecast({...baseInput, horizon: 7.9}, deps(), toolContext());

    expect(bigQueryState.queryJobs.at(-1)?.query).toContain('horizon => 7');
  });

  it.each([
    {
      id: 'history_data',
      overrides: {history_data: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'data_col',
      overrides: {data_col: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'timestamp_col',
      overrides: {timestamp_col: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'qualified data_col',
      overrides: {data_col: 'my_table.my_col'},
      message: 'Invalid BigQuery identifier: my_table.my_col',
    },
    {
      id: 'qualified timestamp_col',
      overrides: {timestamp_col: 'my_dataset:my_col'},
      message: 'Invalid BigQuery identifier: my_dataset:my_col',
    },
    {
      id: 'id_cols',
      overrides: {id_cols: ['valid', 'invalid; drop']},
      message: 'All elements in id_cols must be valid identifiers.',
    },
  ])('test_forecast_invalid_inputs ($id)', async ({overrides, message}) => {
    const result = await forecast(
      {...baseInput, ...overrides},
      deps(),
      toolContext(),
    );

    expect(result).toEqual({status: 'ERROR', error_details: message});
    expect(bigQueryState.queryJobs).toHaveLength(0);
  });

  it('returns the subquery failure without running the forecast', async () => {
    bigQueryState.replies = [{statementType: 'DELETE'}];

    const result = await forecast(
      {...baseInput, history_data: 'SELECT * FROM t'},
      deps(),
      toolContext(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Subquery must be a SELECT statement.',
    });
  });
});

describe('analyzeContribution', () => {
  const baseInput = {
    project_id: 'test-project',
    input_data: 'test-dataset.test-table',
    contribution_metric: 'SUM(metric)',
    dimension_id_cols: ['dim1', 'dim2'],
    is_test_col: 'is_test',
  };

  /** Answers a create-model call and then the get-insights call. */
  function allowModelQueries(): void {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_a',
      },
      {statementType: 'CREATE_MODEL', destinationDatasetId: '_a'},
      {statementType: 'CREATE_MODEL', rows: []},
      {statementType: 'SELECT', rows: [{contributors: ['dim1']}]},
    ];
  }

  it('test_analyze_contribution_with_table_id', async () => {
    allowModelQueries();

    const result = await analyzeContribution(
      baseInput,
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    const queries = bigQueryState.queryJobs.map((job) => job.query);
    expect(queries.some((q) => q.includes('CREATE TEMP MODEL'))).toBe(true);
    expect(
      queries.some((q) => q.includes("MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'")),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("DIMENSION_ID_COLS = ['dim1', 'dim2']")),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes('TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = 30')),
    ).toBe(true);
    expect(
      queries.some((q) =>
        q.includes("PRUNING_METHOD = 'PRUNE_REDUNDANT_INSIGHTS'"),
      ),
    ).toBe(true);
    expect(queries.some((q) => q.includes('ML.GET_INSIGHTS(MODEL '))).toBe(
      true,
    );
    expect(result).toMatchObject({status: 'SUCCESS'});
  });

  it('test_analyze_contribution_with_query_statement', async () => {
    allowModelQueries();

    await analyzeContribution(
      {...baseInput, input_data: 'SELECT * FROM `p.d.t`'},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(
      bigQueryState.queryJobs.some((job) =>
        job.query.includes('AS (SELECT * FROM `p.d.t`)'),
      ),
    ).toBe(true);
  });

  it('test_analyze_contribution_escaping', async () => {
    allowModelQueries();

    await analyzeContribution(
      {...baseInput, contribution_metric: "SUM(o'clock)"},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(
      bigQueryState.queryJobs.some((job) =>
        job.query.includes("CONTRIBUTION_METRIC = 'SUM(o\\'clock)'"),
      ),
    ).toBe(true);
  });

  it('narrows an ALLOWED toolset to a session for the temporary model', async () => {
    allowModelQueries();

    await analyzeContribution(
      baseInput,
      deps({writeMode: WriteMode.ALLOWED}),
      toolContext(),
    );

    expect(bigQueryState.queryJobs.some((job) => job.createSession)).toBe(true);
  });

  it('refuses to run in BLOCKED write mode', async () => {
    const result = await analyzeContribution(baseInput, deps(), toolContext());

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'analyze_contribution is not allowed in this session.',
    });
  });

  it('returns the create-model failure without reading the model', async () => {
    bigQueryState.replies = [{throws: new Error('quota exceeded')}];

    const result = await analyzeContribution(
      baseInput,
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'quota exceeded',
    });
  });

  it.each([
    {
      id: 'input_data',
      overrides: {input_data: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'is_test_col',
      overrides: {is_test_col: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'dimension_id_cols',
      overrides: {dimension_id_cols: ['valid', 'invalid; drop']},
      message: 'All elements in dimension_id_cols must be valid identifiers.',
    },
    {
      id: 'pruning_method',
      overrides: {pruning_method: 'invalid'},
      message: 'Invalid pruning_method: invalid',
    },
  ])(
    'test_analyze_contribution_invalid_inputs ($id)',
    async ({overrides, message}) => {
      const result = await analyzeContribution(
        {...baseInput, ...overrides},
        deps({writeMode: WriteMode.PROTECTED}),
        toolContext(),
      );

      expect(result).toEqual({status: 'ERROR', error_details: message});
    },
  );

  it('accepts NO_PRUNING in any case', async () => {
    allowModelQueries();

    await analyzeContribution(
      {...baseInput, pruning_method: 'no_pruning', top_k_insights: 5},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(
      bigQueryState.queryJobs.some(
        (job) =>
          job.query.includes("PRUNING_METHOD = 'NO_PRUNING'") &&
          job.query.includes('TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = 5'),
      ),
    ).toBe(true);
  });
});

describe('detectAnomalies', () => {
  const baseInput = {
    project_id: 'test-project',
    history_data: 'test-dataset.test-table',
    times_series_timestamp_col: 'ts',
    times_series_data_col: 'value',
  };

  /** Answers a create-model call and then the detect call. */
  function allowModelQueries(): void {
    bigQueryState.replies = [
      {
        statementType: 'SELECT',
        sessionId: 'sess-1',
        destinationDatasetId: '_a',
      },
      {statementType: 'CREATE_MODEL', destinationDatasetId: '_a'},
      {statementType: 'CREATE_MODEL', rows: []},
      {statementType: 'SELECT', rows: [{is_anomaly: true}]},
    ];
  }

  it('test_detect_anomalies_with_table_id', async () => {
    allowModelQueries();

    await detectAnomalies(
      baseInput,
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    const queries = bigQueryState.queryJobs.map((job) => job.query);
    expect(queries.some((q) => q.includes("MODEL_TYPE = 'ARIMA_PLUS'"))).toBe(
      true,
    );
    expect(
      queries.some((q) => q.includes("TIME_SERIES_TIMESTAMP_COL = 'ts'")),
    ).toBe(true);
    expect(queries.some((q) => q.includes('HORIZON = 1000'))).toBe(true);
    expect(
      queries.some((q) =>
        q.includes('STRUCT(0.95 AS anomaly_prob_threshold)) ORDER BY `ts`'),
      ),
    ).toBe(true);
  });

  it('test_detect_anomalies_with_custom_params', async () => {
    allowModelQueries();

    await detectAnomalies(
      {
        ...baseInput,
        horizon: 5,
        anomaly_prob_threshold: 0.8,
        times_series_id_cols: ['store-id'],
      },
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    const queries = bigQueryState.queryJobs.map((job) => job.query);
    expect(queries.some((q) => q.includes('HORIZON = 5'))).toBe(true);
    expect(
      queries.some((q) => q.includes("TIME_SERIES_ID_COL = ['store-id']")),
    ).toBe(true);
    expect(
      queries.some((q) =>
        q.includes(
          'STRUCT(0.8 AS anomaly_prob_threshold)) ORDER BY `store-id`, `ts`',
        ),
      ),
    ).toBe(true);
  });

  it('test_detect_anomalies_on_target_table', async () => {
    allowModelQueries();

    await detectAnomalies(
      {...baseInput, target_data: 'test-dataset.target-table'},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(
      bigQueryState.queryJobs.some((job) =>
        job.query.includes('(SELECT * FROM `test-dataset.target-table`)'),
      ),
    ).toBe(true);
  });

  it('accepts a query as the target data', async () => {
    allowModelQueries();

    await detectAnomalies(
      {...baseInput, target_data: 'SELECT * FROM `p.d.t`'},
      deps({writeMode: WriteMode.PROTECTED}),
      toolContext(),
    );

    expect(
      bigQueryState.queryJobs.some((job) =>
        job.query.includes('), (SELECT * FROM `p.d.t`)) ORDER BY'),
      ),
    ).toBe(true);
  });

  it('refuses to run in BLOCKED write mode', async () => {
    const result = await detectAnomalies(baseInput, deps(), toolContext());

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'anomaly detection is not allowed in this session.',
    });
  });

  it.each([
    {
      id: 'timestamp col',
      overrides: {times_series_timestamp_col: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'data col',
      overrides: {times_series_data_col: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'history data',
      overrides: {history_data: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
    {
      id: 'id cols',
      overrides: {times_series_id_cols: ['valid', 'invalid; drop']},
      message:
        'All elements in times_series_id_cols must be valid identifiers.',
    },
    {
      id: 'target data',
      overrides: {target_data: 'invalid; drop'},
      message: 'Invalid BigQuery identifier: invalid; drop',
    },
  ])(
    'test_detect_anomalies_invalid_inputs ($id)',
    async ({overrides, message}) => {
      const result = await detectAnomalies(
        {...baseInput, ...overrides},
        deps({writeMode: WriteMode.PROTECTED}),
        toolContext(),
      );

      expect(result).toEqual({status: 'ERROR', error_details: message});
    },
  );
});
