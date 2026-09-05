/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_query_tool.py`, plus
 * the adk-js cases the reference has no counterpart for.
 *
 * The reference asserts the docstring of the function `get_execute_sql`
 * returns; the equivalent here is the description
 * {@link executeSqlDescription} produces, because that is what the model
 * reads. Its `test_execute_sql_declaration_*` cases are not ported: they
 * assert a Python function signature, and the schema the model sees is
 * declared with zod here.
 */

import type {BigQuery, Query} from '@google-cloud/bigquery';
import {
  Context,
  GoogleToolStatus,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {getBigQueryClient} from '@google/adk/integrations/bigquery/client.js';
import {
  WriteMode,
  createBigQueryToolSettings,
} from '@google/adk/integrations/bigquery/config.js';
import {
  BIGQUERY_SESSION_INFO_KEY,
  EXECUTE_SQL_DESCRIPTIONS,
  WriteModeRefusal,
  analyzeContribution,
  detectAnomalies,
  executeSqlQuery,
  forecast,
} from '@google/adk/integrations/bigquery/query_tool.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeState, plannedJob, resetFakes} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

const PROJECT = 'test-gcp-project';

function makeContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

function client(): Promise<BigQuery> {
  return getBigQueryClient({project: PROJECT});
}

/** The statement text of the query job the tools planned at `index`. */
function plannedQuery(index: number): string {
  return String(fakeState.bigquery.calls.queryJobs[index].query);
}

/** The statement text of the query the tools ran at `index`. */
function ranQuery(index: number): string {
  return String(fakeState.bigquery.calls.queries[index].query);
}

describe('executeSqlQuery write modes', () => {
  beforeEach(() => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT')],
      rows: [{island: 'Dream', population: 124}],
    });
  });

  it('runs a read in the default blocked mode', async () => {
    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{island: 'Dream', population: 124}],
    });
  });

  it('refuses a write in blocked mode', async () => {
    resetFakes({plannedJobs: [plannedJob('CREATE_TABLE')]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'CREATE TABLE `p.d.t` (a INT64)',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: WriteModeRefusal.BLOCKED,
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('refuses a statement BigQuery reported no type for', async () => {
    resetFakes({plannedJobs: [{}]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'CALL my_procedure()',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: WriteModeRefusal.BLOCKED,
    });
  });

  it('does not echo the refused statement back to the model', async () => {
    resetFakes({plannedJobs: [plannedJob('DELETE')]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'DELETE FROM `p.d.secrets` WHERE token = "hunter2"',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('opens a BigQuery session in protected mode and remembers it', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_TABLE', {destinationDatasetId: '_anon'}),
      ],
      rows: [],
    });
    const toolContext = makeContext();
    const settings = createBigQueryToolSettings({
      writeMode: WriteMode.PROTECTED,
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'CREATE TEMP TABLE t (a INT64)',
      settings,
      toolContext,
      callerId: 'execute_sql',
    });

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
    expect(toolContext.state.get(BIGQUERY_SESSION_INFO_KEY)).toEqual([
      'session-1',
      '_anon',
    ]);
    expect(plannedQuery(0)).toBe('SELECT 1');
    expect(fakeState.bigquery.calls.queryJobs[0].createSession).toBe(true);
    expect(fakeState.bigquery.calls.queries[0].connectionProperties).toEqual([
      {key: 'session_id', value: 'session-1'},
    ]);
  });

  it('reuses the session the context already holds', async () => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT', {destinationDatasetId: '_anon'})],
      rows: [],
    });
    const toolContext = makeContext();
    toolContext.state.set(BIGQUERY_SESSION_INFO_KEY, ['session-9', '_anon']);

    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({writeMode: WriteMode.PROTECTED}),
      toolContext,
      callerId: 'execute_sql',
    });

    // Only the statement itself is planned: no session had to be opened.
    expect(fakeState.bigquery.calls.queryJobs).toHaveLength(1);
    expect(plannedQuery(0)).toBe('SELECT 1');
    expect(fakeState.bigquery.calls.queries[0].connectionProperties).toEqual([
      {key: 'session_id', value: 'session-9'},
    ]);
  });

  it('refuses a permanent write in protected mode', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_TABLE', {destinationDatasetId: 'permanent'}),
      ],
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'CREATE TABLE `p.permanent.t` (a INT64)',
      settings: createBigQueryToolSettings({writeMode: WriteMode.PROTECTED}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: WriteModeRefusal.PROTECTED,
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('allows a write with no destination in protected mode', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('DROP_TABLE'),
      ],
      rows: [],
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'DROP TABLE t',
      settings: createBigQueryToolSettings({writeMode: WriteMode.PROTECTED}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
  });

  it('runs a write in allowed mode without planning it first', async () => {
    resetFakes({rows: []});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'CREATE TABLE `p.d.t` (a INT64)',
      settings: createBigQueryToolSettings({writeMode: WriteMode.ALLOWED}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
    expect(fakeState.bigquery.calls.queryJobs).toHaveLength(0);
    expect(
      fakeState.bigquery.calls.queries[0].connectionProperties,
    ).toBeUndefined();
  });
});

describe('executeSqlQuery result shaping', () => {
  beforeEach(() => {
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: []});
  });

  it('refuses a query aimed outside the compute project', async () => {
    const result = await executeSqlQuery({
      client: await client(),
      projectId: 'another-project',
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({
        computeProjectId: 'compute-project',
      }),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details:
        'Cannot execute query in the project another-project, as the tool is' +
        ' restricted to execute queries only in the project compute-project.',
    });
    expect(fakeState.bigquery.calls.queryJobs).toHaveLength(0);
  });

  it('runs a query aimed at the compute project', async () => {
    const result = await executeSqlQuery({
      client: await client(),
      projectId: 'compute-project',
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({
        computeProjectId: 'compute-project',
      }),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
  });

  it('reports the plan instead of running the query for a dry run', async () => {
    const planned = plannedJob('SELECT');
    resetFakes({plannedJobs: [planned]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      dryRun: true,
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      dry_run_info: planned,
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('flags a result that filled the row cap', async () => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT')],
      rows: [{a: 1}, {a: 2}],
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({maxQueryResultRows: 2}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{a: 1}, {a: 2}],
      result_is_likely_truncated: true,
    });
    expect(fakeState.bigquery.calls.queries[0].maxResults).toBe(2);
  });

  it('does not flag a result below the row cap', async () => {
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: [{a: 1}]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({maxQueryResultRows: 2}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).not.toHaveProperty('result_is_likely_truncated');
  });

  it('stringifies a value that refers back to itself', async () => {
    const circular: Record<string, unknown> = {name: 'row'};
    circular['self'] = circular;
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: [{a: circular}]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{a: '[object Object]'}],
    });
  });

  it('stringifies a value JSON cannot carry', async () => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT')],
      rows: [{total: 9007199254740993n, name: 'ok'}],
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{total: '9007199254740993', name: 'ok'}],
    });
  });

  it('sends the byte budget as the string the SDK expects', async () => {
    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({maximumBytesBilled: 10_485_760}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(fakeState.bigquery.calls.queries[0].maximumBytesBilled).toBe(
      '10485760',
    );
  });

  it('omits the byte budget when none is configured', async () => {
    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(
      fakeState.bigquery.calls.queries[0].maximumBytesBilled,
    ).toBeUndefined();
  });

  it('labels every job with the tool, the application and the caller labels', async () => {
    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({
        applicationName: 'my-agent',
        jobLabels: {team: 'data'},
      }),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(fakeState.bigquery.calls.queries[0].labels).toEqual({
      team: 'data',
      'adk-bigquery-tool': 'execute_sql',
      'adk-bigquery-application-name': 'my-agent',
    });
  });

  it('omits the application label when no application is named', async () => {
    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(fakeState.bigquery.calls.queries[0].labels).toEqual({
      'adk-bigquery-tool': 'execute_sql',
    });
  });

  it('answers a BigQuery failure instead of throwing', async () => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT')],
      errors: {query: new Error('Not found: Table p:d.t')},
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: 'Not found: Table p:d.t',
    });
  });

  it('runs without a tool context, opening a session it cannot remember', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('SELECT', {destinationDatasetId: '_anon'}),
      ],
      rows: [],
    });

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({writeMode: WriteMode.PROTECTED}),
      callerId: 'execute_sql',
    });

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
  });

  it('records an empty session when BigQuery reported none', async () => {
    resetFakes({
      plannedJobs: [plannedJob('SELECT'), plannedJob('SELECT')],
      rows: [],
    });
    const toolContext = makeContext();

    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({writeMode: WriteMode.PROTECTED}),
      toolContext,
      callerId: 'execute_sql',
    });

    expect(toolContext.state.get(BIGQUERY_SESSION_INFO_KEY)).toEqual(['', '']);
  });

  it('answers an empty row list when the SDK returns none', async () => {
    resetFakes({plannedJobs: [plannedJob('SELECT')]});

    const result = await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings({maxQueryResultRows: 2}),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(result).toEqual({status: GoogleToolStatus.SUCCESS, rows: []});
  });
});

describe('executeSqlQuery settings isolation', () => {
  beforeEach(() => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
        plannedJob('SELECT', {destinationDatasetId: '_anon'}),
      ],
      rows: [],
    });
  });

  it('test_tool_call_doesnt_change_global_settings', async () => {
    const settings = createBigQueryToolSettings({
      writeMode: WriteMode.ALLOWED,
    });

    const result = await detectAnomalies(
      await client(),
      {
        projectId: PROJECT,
        historyData: 'd.t',
        timesSeriesTimestampCol: 'ts',
        timesSeriesDataCol: 'v',
      },
      settings,
      makeContext(),
    );

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
    // The analysis narrows the mode to open a session; the caller's own
    // settings must not follow it.
    expect(settings.writeMode).toBe(WriteMode.ALLOWED);
  });

  it('test_tool_call_doesnt_mutate_job_labels', async () => {
    const settings = createBigQueryToolSettings({
      writeMode: WriteMode.ALLOWED,
      jobLabels: {environment: 'test', team: 'data'},
    });

    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings,
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    expect(settings.jobLabels).toEqual({environment: 'test', team: 'data'});
  });

  it('labels a machine-learning job with the tool that started it', async () => {
    await detectAnomalies(
      await client(),
      {
        projectId: PROJECT,
        historyData: 'd.t',
        timesSeriesTimestampCol: 'ts',
        timesSeriesDataCol: 'v',
      },
      createBigQueryToolSettings({
        writeMode: WriteMode.ALLOWED,
        applicationName: 'my-agent',
      }),
      makeContext(),
    );

    for (const request of fakeState.bigquery.calls.queries) {
      expect(request.labels).toEqual({
        'adk-bigquery-tool': 'detect_anomalies',
        'adk-bigquery-application-name': 'my-agent',
      });
    }
  });
});

describe('EXECUTE_SQL_DESCRIPTIONS', () => {
  it('tells the model what each write mode accepts', () => {
    const blocked = EXECUTE_SQL_DESCRIPTIONS[WriteMode.BLOCKED];
    const protectedMode = EXECUTE_SQL_DESCRIPTIONS[WriteMode.PROTECTED];
    const allowed = EXECUTE_SQL_DESCRIPTIONS[WriteMode.ALLOWED];

    expect(new Set([blocked, protectedMode, allowed]).size).toBe(3);
    expect(blocked).toContain('Only SELECT statements are accepted');
    expect(protectedMode).toContain('CREATE TEMP TABLE');
    expect(protectedMode).toContain('Do not create, change or delete a');
    expect(allowed).toContain('Every statement is accepted');
  });
});

describe('forecast', () => {
  beforeEach(() => {
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: [{value: 1}]});
  });

  async function runForecast(
    options: Parameters<typeof forecast>[1],
  ): Promise<unknown> {
    return forecast(
      await client(),
      options,
      createBigQueryToolSettings(),
      makeContext(),
    );
  }

  it('reads a table id as a TABLE reference', async () => {
    const result = await runForecast({
      projectId: PROJECT,
      historyData: 'my-dataset.my-sales-table',
      timestampCol: 'sale_date',
      dataCol: 'daily_sales',
      horizon: 7,
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{value: 1}],
    });
    const query = ranQuery(0);
    expect(query).toContain('TABLE `my-dataset.my-sales-table`');
    expect(query).toContain("data_col => 'daily_sales'");
    expect(query).toContain("timestamp_col => 'sale_date'");
    expect(query).toContain("model => 'TimesFM 2.0'");
    expect(query).toContain('horizon => 7');
    expect(query).toContain('confidence_level => 0.95');
    expect(query).not.toContain('id_cols');
  });

  it('reads a SELECT statement as a subquery', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: '  select ts, v from `p.d.t`  ',
      timestampCol: 'ts',
      dataCol: 'v',
    });

    expect(ranQuery(0)).toContain('(  select ts, v from `p.d.t`  )');
  });

  it('reads a WITH statement as a subquery', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'WITH x AS (SELECT 1) SELECT * FROM x',
      timestampCol: 'ts',
      dataCol: 'v',
    });

    expect(ranQuery(0)).toContain('(WITH x AS (SELECT 1) SELECT * FROM x)');
  });

  it('defaults the horizon when the model names none', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'd.t',
      timestampCol: 'ts',
      dataCol: 'v',
    });

    expect(ranQuery(0)).toContain('horizon => 10');
  });

  it('lists the id columns when the model names some', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'd.t',
      timestampCol: 'ts',
      dataCol: 'v',
      idCols: ['store_id', 'region'],
    });

    expect(ranQuery(0)).toContain("id_cols => ['store_id', 'region']");
  });

  it('ignores an empty id column list', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'd.t',
      timestampCol: 'ts',
      dataCol: 'v',
      idCols: [],
    });

    expect(ranQuery(0)).not.toContain('id_cols');
  });

  it('escapes a quote the model put in a column name', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'd.t',
      timestampCol: "ts', horizon => 999, x => '",
      dataCol: 'v',
    });

    expect(ranQuery(0)).toContain(
      "timestamp_col => 'ts\\', horizon => 999, x => \\''",
    );
    expect(ranQuery(0)).toContain('horizon => 10');
  });

  it('labels the job with the calling tool', async () => {
    await runForecast({
      projectId: PROJECT,
      historyData: 'd.t',
      timestampCol: 'ts',
      dataCol: 'v',
    });

    const labels = fakeState.bigquery.calls.queries[0].labels as Record<
      string,
      string
    >;
    expect(labels['adk-bigquery-tool']).toBe('forecast');
  });
});

describe('analyzeContribution', () => {
  const options = {
    projectId: PROJECT,
    inputData: 'my-dataset.sales',
    contributionMetric: 'SUM(revenue)',
    dimensionIdCols: ['store', 'category'],
    isTestCol: 'is_test',
  };

  beforeEach(() => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
        plannedJob('SELECT', {destinationDatasetId: '_anon'}),
      ],
      rows: [{contributors: ['S2']}],
    });
  });

  function settings(writeMode = WriteMode.ALLOWED) {
    return createBigQueryToolSettings({writeMode});
  }

  it('creates a temporary model, then reads its insights', async () => {
    const result = await analyzeContribution(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{contributors: ['S2']}],
    });
    expect(ranQuery(0)).toContain(
      'CREATE TEMP MODEL contribution_analysis_model_',
    );
    expect(ranQuery(0)).toContain("MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'");
    expect(ranQuery(0)).toContain("CONTRIBUTION_METRIC = 'SUM(revenue)'");
    expect(ranQuery(0)).toContain("IS_TEST_COL = 'is_test'");
    expect(ranQuery(0)).toContain("DIMENSION_ID_COLS = ['store', 'category']");
    expect(ranQuery(0)).toContain('TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = 30');
    expect(ranQuery(0)).toContain(
      "PRUNING_METHOD = 'PRUNE_REDUNDANT_INSIGHTS'",
    );
    expect(ranQuery(0)).toContain('AS SELECT * FROM `my-dataset.sales`');
    expect(ranQuery(1)).toContain('ML.GET_INSIGHTS(MODEL');
  });

  it('runs both statements in one BigQuery session', async () => {
    await analyzeContribution(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    const [first, second] = fakeState.bigquery.calls.queries;
    expect(first.connectionProperties).toEqual([
      {key: 'session_id', value: 'session-1'},
    ]);
    expect(second.connectionProperties).toEqual(first.connectionProperties);
  });

  it('keeps the caller in protected mode rather than widening it', async () => {
    await analyzeContribution(
      await client(),
      options,
      settings(WriteMode.PROTECTED),
      makeContext(),
    );

    expect(fakeState.bigquery.calls.queries).toHaveLength(2);
  });

  it('refuses to run when the toolset blocks writes', async () => {
    await expect(
      analyzeContribution(
        await client(),
        options,
        settings(WriteMode.BLOCKED),
        makeContext(),
      ),
    ).rejects.toThrow('analyze_contribution is not allowed in this session.');
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('rejects a pruning method BigQuery does not offer', async () => {
    const result = await analyzeContribution(
      await client(),
      {...options, pruningMethod: 'DELETE_EVERYTHING'},
      settings(),
      makeContext(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: 'Invalid pruning_method: DELETE_EVERYTHING',
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('accepts a pruning method the model spelled in lower case', async () => {
    await analyzeContribution(
      await client(),
      {...options, pruningMethod: 'no_pruning'},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain("PRUNING_METHOD = 'NO_PRUNING'");
  });

  it('keeps the insight count the model asked for', async () => {
    await analyzeContribution(
      await client(),
      {...options, topKInsights: 5},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain('TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = 5');
  });

  it('reads a SELECT input as a subquery', async () => {
    await analyzeContribution(
      await client(),
      {...options, inputData: 'SELECT * FROM `p.d.t`'},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain('AS (SELECT * FROM `p.d.t`)');
  });

  it('stops when creating the model failed', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
      ],
      errors: {query: new Error('Quota exceeded')},
    });

    const result = await analyzeContribution(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: 'Quota exceeded',
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(1);
  });

  it('names a different temporary model on every call', async () => {
    await analyzeContribution(
      await client(),
      options,
      settings(),
      makeContext(),
    );
    const first = ranQuery(0);
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
        plannedJob('SELECT', {destinationDatasetId: '_anon'}),
      ],
      rows: [],
    });
    await analyzeContribution(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).not.toBe(first);
  });
});

describe('detectAnomalies', () => {
  const options = {
    projectId: PROJECT,
    historyData: 'my-dataset.sales',
    timesSeriesTimestampCol: 'sale_date',
    timesSeriesDataCol: 'daily_sales',
  };

  beforeEach(() => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
        plannedJob('SELECT', {destinationDatasetId: '_anon'}),
      ],
      rows: [{is_anomaly: true}],
    });
  });

  function settings(writeMode = WriteMode.ALLOWED) {
    return createBigQueryToolSettings({writeMode});
  }

  it('trains a temporary ARIMA_PLUS model, then reads its anomalies', async () => {
    const result = await detectAnomalies(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{is_anomaly: true}],
    });
    expect(ranQuery(0)).toContain("MODEL_TYPE = 'ARIMA_PLUS'");
    expect(ranQuery(0)).toContain("TIME_SERIES_TIMESTAMP_COL = 'sale_date'");
    expect(ranQuery(0)).toContain("TIME_SERIES_DATA_COL = 'daily_sales'");
    expect(ranQuery(0)).toContain('HORIZON = 1000');
    expect(ranQuery(0)).not.toContain('TIME_SERIES_ID_COL');
    expect(ranQuery(1)).toContain(
      'STRUCT(0.95 AS anomaly_prob_threshold)) ORDER BY sale_date',
    );
  });

  it('orders by the id columns before the timestamp', async () => {
    await detectAnomalies(
      await client(),
      {...options, timesSeriesIdCols: ['unique_id']},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain("TIME_SERIES_ID_COL = ['unique_id']");
    expect(ranQuery(1)).toContain('ORDER BY unique_id, sale_date');
  });

  it('inspects the target data when the model names some', async () => {
    await detectAnomalies(
      await client(),
      {...options, targetData: 'my-dataset.recent'},
      settings(),
      makeContext(),
    );

    expect(ranQuery(1)).toContain('(SELECT * FROM `my-dataset.recent`)');
  });

  it('reads a SELECT target as a subquery', async () => {
    await detectAnomalies(
      await client(),
      {...options, targetData: 'SELECT * FROM `p.d.recent`'},
      settings(),
      makeContext(),
    );

    expect(ranQuery(1)).toContain('(SELECT * FROM `p.d.recent`)');
  });

  it('keeps the horizon and the threshold the model asked for', async () => {
    await detectAnomalies(
      await client(),
      {...options, horizon: 30, anomalyProbThreshold: 0.5},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain('HORIZON = 30');
    expect(ranQuery(1)).toContain('STRUCT(0.5 AS anomaly_prob_threshold)');
  });

  it('refuses to run when the toolset blocks writes', async () => {
    await expect(
      detectAnomalies(
        await client(),
        options,
        settings(WriteMode.BLOCKED),
        makeContext(),
      ),
    ).rejects.toThrow('anomaly detection is not allowed in this session.');
    expect(fakeState.bigquery.calls.queries).toHaveLength(0);
  });

  it('stops when training the model failed', async () => {
    resetFakes({
      plannedJobs: [
        plannedJob('SELECT', {
          sessionId: 'session-1',
          destinationDatasetId: '_anon',
        }),
        plannedJob('CREATE_MODEL', {destinationDatasetId: '_anon'}),
      ],
      errors: {query: new Error('Not enough data points')},
    });

    const result = await detectAnomalies(
      await client(),
      options,
      settings(),
      makeContext(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: 'Not enough data points',
    });
    expect(fakeState.bigquery.calls.queries).toHaveLength(1);
  });

  it('reads a SELECT history as a subquery', async () => {
    await detectAnomalies(
      await client(),
      {...options, historyData: 'SELECT * FROM `p.d.history`'},
      settings(),
      makeContext(),
    );

    expect(ranQuery(0)).toContain('AS (SELECT * FROM `p.d.history`)');
  });
});

describe('query request shape', () => {
  it('bills the query to the project the model named', async () => {
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: []});

    await executeSqlQuery({
      client: await client(),
      projectId: PROJECT,
      query: 'SELECT 1',
      settings: createBigQueryToolSettings(),
      toolContext: makeContext(),
      callerId: 'execute_sql',
    });

    const request: Query = fakeState.bigquery.calls.queries[0];
    expect(request.projectId).toBe(PROJECT);
  });
});
