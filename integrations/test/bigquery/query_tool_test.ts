/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BigQueryOptions,
  JobMetadata,
  Query,
  QueryOptions,
} from '@google-cloud/bigquery';
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {
  BIGQUERY_SESSION_INFO_KEY,
  BigQueryToolset,
  BigQueryToolsetOptions,
  WriteMode,
  version,
} from '@google/adk-integrations';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const bq = vi.hoisted(() => ({
  clients: [] as BigQueryOptions[],
  jobRequests: [] as Query[],
  queryRequests: [] as Array<{request: Query; options?: QueryOptions}>,
  createQueryJob: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    constructor(options: BigQueryOptions) {
      bq.clients.push(options);
    }

    createQueryJob(request: Query) {
      bq.jobRequests.push({...request});
      return bq.createQueryJob(request);
    }

    query(request: Query, options?: QueryOptions) {
      bq.queryRequests.push({request: {...request}, options});
      return bq.query(request, options);
    }
  },
}));

const USER_AGENT_BASE = `adk-bigquery-tool google-adk/${version}`;
const SELECT_QUERY = 'SELECT island FROM `p`.`d`.`penguins`';
const WRITE_QUERY = 'DROP TABLE `p`.`d`.`penguins`';

/** A dry-run job the mocked client resolves with. */
function job(metadata: JobMetadata): [{metadata: JobMetadata}] {
  return [{metadata}];
}

/** The dry-run answer for a query BigQuery classifies as `statementType`. */
function classified(
  statementType: string,
  destinationDatasetId?: string,
  sessionId?: string,
): [{metadata: JobMetadata}] {
  return job({
    statistics: {
      query: {statementType},
      ...(sessionId ? {sessionInfo: {sessionId}} : {}),
    },
    ...(destinationDatasetId
      ? {
          configuration: {
            query: {destinationTable: {datasetId: destinationDatasetId}},
          },
        }
      : {}),
  });
}

function makeContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: 'fc-1',
  });
}

/** The SQL tool of a toolset built with `options`, under its exposed name. */
async function executeSqlTool(
  options: BigQueryToolsetOptions,
  name = 'execute_sql',
) {
  const tools = await new BigQueryToolset(options).getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`the toolset exposes no tool named ${name}`);
  }
  return tool;
}

async function runExecuteSql(
  options: BigQueryToolsetOptions,
  args: Record<string, unknown>,
  toolContext: Context = makeContext(),
  name?: string,
): Promise<unknown> {
  const tool = await executeSqlTool(options, name);
  return tool.runAsync({args, toolContext});
}

/** The description the model reads for a toolset built with `options`. */
async function executeSqlDescription(
  options: BigQueryToolsetOptions,
): Promise<string> {
  return (await executeSqlTool(options)).description;
}

beforeEach(() => {
  bq.clients.length = 0;
  bq.jobRequests.length = 0;
  bq.queryRequests.length = 0;
  vi.clearAllMocks();
  bq.query.mockResolvedValue([[]]);
});

describe('execute_sql declaration', () => {
  it('describes only reads when no configuration is given', async () => {
    const description = await executeSqlDescription({});

    expect(description).toContain('Run a BigQuery or BigQuery ML SQL query');
    expect(description).not.toContain('CREATE TABLE');
    expect(description).not.toContain('CREATE TEMP TABLE');
  });

  it('describes only reads for an empty tool configuration', async () => {
    const description = await executeSqlDescription({toolConfig: {}});

    expect(description).not.toContain('CREATE TABLE');
    expect(description).not.toContain('CREATE TEMP TABLE');
  });

  it('describes only reads in blocked write mode', async () => {
    const description = await executeSqlDescription({
      toolConfig: {writeMode: WriteMode.BLOCKED},
    });

    expect(description).not.toContain('CREATE TABLE');
    expect(description).not.toContain('CREATE TEMP TABLE');
  });

  it('describes permanent writes in allowed write mode', async () => {
    const description = await executeSqlDescription({
      toolConfig: {writeMode: WriteMode.ALLOWED},
    });

    expect(description).toContain('CREATE TABLE');
    expect(description).toContain('Use "CREATE OR REPLACE TABLE"');
    expect(description).not.toContain('CREATE TEMP TABLE');
  });

  it('describes temporary writes in protected write mode', async () => {
    const description = await executeSqlDescription({
      toolConfig: {writeMode: WriteMode.PROTECTED},
    });

    expect(description).toContain('CREATE TEMP TABLE');
    expect(description).toContain(
      'Only temporary tables can be created, inserted into or deleted.',
    );
  });
});

describe('execute_sql', () => {
  it('runs a SELECT in blocked write mode', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    bq.query.mockResolvedValue([[{island: 'Dream', population: 124}]]);

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: SELECT_QUERY,
      },
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{island: 'Dream', population: 124}],
    });
    expect(bq.jobRequests[0]).toMatchObject({
      query: SELECT_QUERY,
      dryRun: true,
    });
  });

  it('runs a SELECT in allowed write mode without a dry run', async () => {
    bq.query.mockResolvedValue([[{island: 'Dream'}]]);

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.ALLOWED}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: [{island: 'Dream'}]});
    expect(bq.createQueryJob).not.toHaveBeenCalled();
  });

  it('runs a SELECT in protected write mode', async () => {
    bq.createQueryJob
      .mockResolvedValueOnce(classified('SELECT', 'anon_dataset', 'sess-1'))
      .mockResolvedValueOnce(classified('SELECT'));
    bq.query.mockResolvedValue([[{island: 'Dream'}]]);

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: [{island: 'Dream'}]});
  });

  it.each([
    'CREATE_TABLE_AS_SELECT',
    'DROP_TABLE',
    'CREATE_MODEL',
    'DROP_MODEL',
  ])('refuses a %s statement in blocked write mode', async (statementType) => {
    bq.createQueryJob.mockResolvedValue(classified(statementType));

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: WRITE_QUERY,
      },
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
    expect(bq.query).not.toHaveBeenCalled();
  });

  it.each([
    'CREATE_TABLE_AS_SELECT',
    'DROP_TABLE',
    'CREATE_MODEL',
    'DROP_MODEL',
  ])('runs a %s statement in allowed write mode', async (statementType) => {
    bq.createQueryJob.mockResolvedValue(classified(statementType));
    bq.query.mockResolvedValue([[]]);

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.ALLOWED}},
      {project_id: 'my-project', query: WRITE_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
  });

  it('runs a write into the session dataset in protected write mode', async () => {
    bq.createQueryJob
      .mockResolvedValueOnce(classified('SELECT', 'anon_dataset', 'sess-1'))
      .mockResolvedValueOnce(
        classified('CREATE_TABLE_AS_SELECT', 'anon_dataset'),
      );
    bq.query.mockResolvedValue([[]]);

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: 'CREATE TEMP TABLE t AS SELECT 1'},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
  });

  it('refuses a write into a permanent dataset in protected write mode', async () => {
    bq.createQueryJob
      .mockResolvedValueOnce(classified('SELECT', 'anon_dataset', 'sess-1'))
      .mockResolvedValueOnce(classified('DROP_TABLE', 'my_dataset'));

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: WRITE_QUERY},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details:
        'Protected write mode only supports SELECT statements, or write ' +
        'operations in the anonymous dataset of a BigQuery session.',
    });
    expect(bq.query).not.toHaveBeenCalled();
  });

  it('runs a write with no destination table in protected write mode', async () => {
    bq.createQueryJob
      .mockResolvedValueOnce(classified('SELECT', 'anon_dataset', 'sess-1'))
      .mockResolvedValueOnce(classified('DROP_TABLE'));
    bq.query.mockResolvedValue([[]]);

    const result = await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: WRITE_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
  });

  it('opens a BigQuery session and remembers it', async () => {
    bq.createQueryJob
      .mockResolvedValueOnce(classified('SELECT', 'anon_dataset', 'sess-1'))
      .mockResolvedValueOnce(classified('SELECT'));
    const toolContext = makeContext();

    await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: SELECT_QUERY},
      toolContext,
    );

    expect(bq.jobRequests[0]).toMatchObject({
      query: 'SELECT 1',
      createSession: true,
      dryRun: true,
    });
    expect(toolContext.state.get(BIGQUERY_SESSION_INFO_KEY)).toEqual([
      'sess-1',
      'anon_dataset',
    ]);
    expect(bq.jobRequests[1].connectionProperties).toEqual([
      {key: 'session_id', value: 'sess-1'},
    ]);
  });

  it('reuses the remembered session on a later call', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    const toolContext = makeContext();
    toolContext.state.set(BIGQUERY_SESSION_INFO_KEY, [
      'sess-existing',
      'anon_existing',
    ]);

    await runExecuteSql(
      {toolConfig: {writeMode: WriteMode.PROTECTED}},
      {project_id: 'my-project', query: SELECT_QUERY},
      toolContext,
    );

    expect(bq.jobRequests).toHaveLength(1);
    expect(bq.jobRequests[0].connectionProperties).toEqual([
      {key: 'session_id', value: 'sess-existing'},
    ]);
  });

  it('returns the dry-run job instead of running the query', async () => {
    const dryRunJob = classified('SELECT');
    bq.createQueryJob.mockResolvedValue(dryRunJob);

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: SELECT_QUERY,
        dry_run: true,
      },
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      dry_run_info: dryRunJob[0].metadata,
    });
    expect(bq.query).not.toHaveBeenCalled();
  });

  it('caps the rows and flags the result as truncated', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    bq.query.mockResolvedValue([
      Array.from({length: 5}, (_unused, index) => ({index})),
    ]);

    const result = await runExecuteSql(
      {toolConfig: {maxQueryResultRows: 2}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{index: 0}, {index: 1}],
      result_is_likely_truncated: true,
    });
    expect(bq.queryRequests[0].options).toMatchObject({maxResults: 2});
  });

  it('leaves a result under the cap unflagged', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    bq.query.mockResolvedValue([[{index: 0}]]);

    const result = await runExecuteSql(
      {toolConfig: {maxQueryResultRows: 2}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: [{index: 0}]});
  });

  it('replaces a value JSON cannot serialize with its string form', async () => {
    const circular: Record<string, unknown> = {name: 'loop'};
    circular.self = circular;
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    bq.query.mockResolvedValue([[{island: 'Dream', trace: circular}]]);

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: SELECT_QUERY,
      },
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{island: 'Dream', trace: '[object Object]'}],
    });
  });

  it('refuses a project the compute guardrail excludes', async () => {
    const result = await runExecuteSql(
      {toolConfig: {computeProjectId: 'compute-project'}},
      {project_id: 'other-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details:
        'Cannot execute query in the project other-project, as the tool is ' +
        'restricted to execute queries only in the project compute-project.',
    });
    expect(bq.clients).toHaveLength(0);
  });

  it('runs a query in the project the compute guardrail names', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    const result = await runExecuteSql(
      {toolConfig: {computeProjectId: 'compute-project'}},
      {project_id: 'compute-project', query: SELECT_QUERY},
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
    expect(bq.clients[0].projectId).toBe('compute-project');
  });

  it('forwards the byte cap to the query job', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql(
      {toolConfig: {maximumBytesBilled: 10_485_760}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(bq.queryRequests[0].request.maximumBytesBilled).toBe('10485760');
  });

  it('leaves the byte cap unset when none is configured', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql({}, {project_id: 'my-project', query: SELECT_QUERY});

    expect(bq.queryRequests[0].request.maximumBytesBilled).toBeUndefined();
  });

  it('labels every job with the tool name', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql({}, {project_id: 'my-project', query: SELECT_QUERY});

    expect(bq.jobRequests[0].labels).toEqual({
      'adk-bigquery-tool': 'execute_sql',
    });
  });

  it('adds the configured labels and the application name', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql(
      {
        toolConfig: {
          jobLabels: {environment: 'test'},
          applicationName: 'my-app',
        },
      },
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(bq.queryRequests[0].request.labels).toEqual({
      environment: 'test',
      'adk-bigquery-tool': 'execute_sql',
      'adk-bigquery-application-name': 'my-app',
    });
  });

  it('identifies the calling tool in the user agent', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql(
      {toolConfig: {applicationName: 'my-app'}},
      {project_id: 'my-project', query: SELECT_QUERY},
    );

    expect(bq.clients[0].userAgent).toBe(
      `${USER_AGENT_BASE} my-app execute_sql`,
    );
  });

  it('reports a BigQuery failure to the model instead of throwing', async () => {
    bq.createQueryJob.mockRejectedValue(new Error('quota exceeded'));

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: SELECT_QUERY,
      },
    );

    expect(result).toEqual({status: 'ERROR', error_details: 'quota exceeded'});
  });

  it('reports a rejection that is not an Error', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));
    bq.query.mockRejectedValue('connection reset');

    const result = await runExecuteSql(
      {},
      {
        project_id: 'my-project',
        query: SELECT_QUERY,
      },
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'connection reset',
    });
  });

  it('prefixes the tool name and keeps the plain name on the wire', async () => {
    bq.createQueryJob.mockResolvedValue(classified('SELECT'));

    await runExecuteSql(
      {prefix: 'warehouse'},
      {project_id: 'my-project', query: SELECT_QUERY},
      makeContext(),
      'warehouse_execute_sql',
    );

    expect(bq.clients[0].userAgent).toBe(`${USER_AGENT_BASE} execute_sql`);
    expect(bq.jobRequests[0].labels).toEqual({
      'adk-bigquery-tool': 'execute_sql',
    });
  });
});
