/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery} from '@google-cloud/bigquery';
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {Mock, beforeEach, describe, expect, it, vi} from 'vitest';

import {WriteMode} from '../../src/bigquery/bigquery_config.js';
import {BigQueryToolset} from '../../src/bigquery/bigquery_toolset.js';
import {getBigQueryClient} from '../../src/bigquery/client.js';
import * as metadataTools from '../../src/bigquery/metadata_tools.js';
import * as queryTools from '../../src/bigquery/query_tools.js';

// Mock the BigQuery client module
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn(),
}));

/**
 * The subset of the BigQuery client surface these tools touch. Declaring it
 * explicitly keeps the doubles type-checked: a renamed or misspelled method is
 * a compile error instead of a silently-undefined property.
 */
interface MockBigQueryClient {
  dataset: Mock;
  job: Mock;
  getDatasets: Mock;
  createQueryJob: Mock;
  query: Mock;
}

function createMockBigQueryClient(): MockBigQueryClient {
  return {
    dataset: vi.fn(),
    job: vi.fn(),
    getDatasets: vi.fn(),
    createQueryJob: vi.fn(),
    query: vi.fn(),
  };
}

/**
 * Installs `client` as the object returned by `new BigQuery(...)`.
 *
 * A partial double cannot structurally satisfy the whole `BigQuery` class, so
 * the substitution is asserted exactly once, here, instead of at every call
 * site. Everything the tests touch stays typed via {@link MockBigQueryClient}.
 */
function installMockBigQueryClient(client: MockBigQueryClient): void {
  vi.mocked(BigQuery).mockImplementation(() => client as unknown as BigQuery);
}

function createInvocationContext(
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      state,
    }),
    pluginManager: new PluginManager(),
  });
}

/** A real `Context`, so `context.state` is a real delta-aware `State`. */
function createToolContext(state: Record<string, unknown> = {}): Context {
  return new Context({invocationContext: createInvocationContext(state)});
}

describe('BigQuery client', () => {
  it('should instantiate BigQuery correctly', () => {
    getBigQueryClient(
      'my-proj',
      {keyFilename: 'key.json'},
      {location: 'US'},
      'caller',
    );
    expect(BigQuery).toHaveBeenCalledWith({
      projectId: 'my-proj',
      keyFilename: 'key.json',
      credentials: undefined,
      userAgent: 'adk-bigquery/caller',
      location: 'US',
    });
  });

  it('should infer project id', () => {
    getBigQueryClient(undefined, {projectId: 'p2'});
    expect(BigQuery).toHaveBeenCalledWith({
      projectId: 'p2',
      keyFilename: undefined,
      credentials: undefined,
      userAgent: 'adk-bigquery',
    });
  });
});

describe('Metadata tools', () => {
  let mockBqClient: MockBigQueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    mockBqClient = createMockBigQueryClient();
    installMockBigQueryClient(mockBqClient);
  });

  it('listDatasetIds', async () => {
    mockBqClient.getDatasets.mockResolvedValue([
      [{id: 'd1'}, {}, {id: 'd2'}],
      {},
    ]);
    const res = await metadataTools.listDatasetIds('proj');
    expect(res).toEqual({status: 'SUCCESS', datasets: ['d1', 'd2']});

    mockBqClient.getDatasets.mockRejectedValue(new Error('error msg'));
    const errRes = await metadataTools.listDatasetIds('proj');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'error msg'});

    mockBqClient.getDatasets.mockRejectedValue('string error');
    const errRes2 = await metadataTools.listDatasetIds('proj');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'string error'});
  });

  it('getDatasetInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 'd1'}}]);
    mockBqClient.dataset.mockReturnValue({get: mockGet});
    const res = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(res).toEqual({id: 'd1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('listTableIds', async () => {
    const mockGetTables = vi.fn().mockResolvedValue([[{id: 't1'}, {}]]);
    mockBqClient.dataset.mockReturnValue({getTables: mockGetTables});
    const res = await metadataTools.listTableIds('proj', 'd1');
    expect(res).toEqual({status: 'SUCCESS', tables: ['t1']});

    mockGetTables.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.listTableIds('proj', 'd1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGetTables.mockRejectedValue('str err');
    const errRes2 = await metadataTools.listTableIds('proj', 'd1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('getTableInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 't1'}}]);
    const mockTable = vi.fn().mockReturnValue({get: mockGet});
    mockBqClient.dataset.mockReturnValue({table: mockTable});

    const res = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(res).toEqual({id: 't1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('getJobInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 'j1'}}]);
    mockBqClient.job.mockReturnValue({get: mockGet});

    const res = await metadataTools.getJobInfo('proj', 'j1');
    expect(res).toEqual({id: 'j1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getJobInfo('proj', 'j1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getJobInfo('proj', 'j1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });
});

describe('Query tools', () => {
  let mockBqClient: MockBigQueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    mockBqClient = createMockBigQueryClient();
    installMockBigQueryClient(mockBqClient);
  });

  it('executeSql - blocked compute project', async () => {
    const res = await queryTools.executeSql('proj1', 'sql', undefined, {
      computeProjectId: 'proj2',
    });
    expect(res).toMatchObject({
      status: 'ERROR',
      error_details: expect.stringContaining('Cannot execute query'),
    });
  });

  it('executeSql - blocked mode checks for SELECT', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {metadata: {statistics: {query: {statementType: 'UPDATE'}}}},
    ]);
    const res = await queryTools.executeSql('p', 'update', undefined, {
      writeMode: WriteMode.BLOCKED,
      applicationName: 'app1',
    });
    expect(res).toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
  });

  it('executeSql - protected mode creates and persists a session', async () => {
    mockBqClient.createQueryJob
      .mockResolvedValueOnce([
        {
          metadata: {
            statistics: {sessionInfo: {sessionId: 'sec1'}},
            configuration: {query: {destinationTable: {datasetId: 'd1'}}},
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          metadata: {
            statistics: {query: {statementType: 'UPDATE'}},
            configuration: {query: {destinationTable: {datasetId: 'd2'}}},
          },
        },
      ]);
    const ctx = createToolContext();
    const res = await queryTools.executeSql(
      'p',
      'update t1',
      undefined,
      {writeMode: WriteMode.PROTECTED, jobLabels: {k: 'v'}},
      ctx,
    );
    expect(res).toMatchObject({
      status: 'ERROR',
      error_details: expect.stringContaining(
        'Protected write mode only supports SELECT statements',
      ),
    });
    // The newly created session must be written back to the session state so
    // that a later call reuses it.
    expect(ctx.state.get('bigquery_session_info')).toEqual(['sec1', 'd1']);
    expect(ctx.actions.stateDelta['bigquery_session_info']).toEqual([
      'sec1',
      'd1',
    ]);
  });

  it('executeSql - protected mode reuses a session from state', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {
        metadata: {
          statistics: {query: {statementType: 'UPDATE'}},
          configuration: {query: {destinationTable: {datasetId: 'd1'}}},
        },
      },
    ]);
    const ctx = createToolContext({bigquery_session_info: ['sec1', 'd1']});

    mockBqClient.query.mockResolvedValue([[{a: 1}]]);

    const res = await queryTools.executeSql(
      'p',
      'update t1',
      undefined,
      {writeMode: WriteMode.PROTECTED},
      ctx,
    );
    expect(res).toEqual({status: 'SUCCESS', rows: [{a: 1}]});
    // The existing session id is forwarded rather than a new one created.
    expect(mockBqClient.query).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionProperties: [{key: 'session_id', value: 'sec1'}],
      }),
      {maxResults: undefined},
    );
  });

  it('executeSql - protected mode with missing sessionInfo', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {
        metadata: {
          statistics: {},
          configuration: {query: {destinationTable: {datasetId: 'd1'}}},
        },
      },
    ]);
    const ctx = createToolContext();
    const res = await queryTools.executeSql(
      'p',
      'update t1',
      undefined,
      {writeMode: WriteMode.PROTECTED},
      ctx,
    );
    expect(res).toMatchObject({status: 'ERROR'});
    // No session was created, so nothing should have been persisted.
    expect(ctx.state.get('bigquery_session_info')).toBeUndefined();
  });

  it('executeSql - success flow with dryRun', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {metadata: {statistics: {query: {statementType: 'SELECT'}}}},
    ]);
    const res = await queryTools.executeSql(
      'p',
      'sel',
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(res).toEqual({
      status: 'SUCCESS',
      dry_run_info: {statistics: {query: {statementType: 'SELECT'}}},
    });
    expect(mockBqClient.query).not.toHaveBeenCalled();
  });

  it('executeSql - unwraps native values and pushes the row cap into the request', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {metadata: {statistics: {query: {statementType: 'SELECT'}}}},
    ]);
    // The client caps the response itself, so it returns at most maxResults
    // rows rather than the full result set.
    mockBqClient.query.mockResolvedValue([
      [{col1: {value: 'v1'}}, {col1: 'v2'}],
    ]);
    const res = await queryTools.executeSql('p', 'sel', undefined, {
      maxQueryResultRows: 2,
      maximumBytesBilled: 100,
    });
    expect(res).toEqual({
      status: 'SUCCESS',
      rows: [{col1: 'v1'}, {col1: 'v2'}],
      result_is_likely_truncated: true,
    });
    expect(mockBqClient.query).toHaveBeenCalledWith(
      // `maximumBytesBilled` is an int64 REST field, so the SDK wants a string.
      expect.objectContaining({maximumBytesBilled: '100'}),
      {maxResults: 2},
    );
  });

  it('executeSql - does not flag truncation below the row cap', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([
      {metadata: {statistics: {query: {statementType: 'SELECT'}}}},
    ]);
    mockBqClient.query.mockResolvedValue([[{col1: 'v1'}]]);
    const res = await queryTools.executeSql('p', 'sel', undefined, {
      maxQueryResultRows: 5,
    });
    expect(res).toEqual({status: 'SUCCESS', rows: [{col1: 'v1'}]});
  });

  it('executeSql - error catching', async () => {
    mockBqClient.query.mockRejectedValue(new Error('bq err'));
    mockBqClient.createQueryJob.mockResolvedValue([
      {metadata: {statistics: {query: {statementType: 'SELECT'}}}},
    ]);
    const res = await queryTools.executeSql('p', 'sel', undefined, {
      writeMode: WriteMode.ALLOWED,
    });
    expect(res).toEqual({status: 'ERROR', error_details: 'bq err'});

    mockBqClient.query.mockRejectedValue('str err');
    const res2 = await queryTools.executeSql('p', 'sel', undefined, {
      writeMode: WriteMode.ALLOWED,
    });
    expect(res2).toEqual({status: 'ERROR', error_details: 'str err'});
  });
});

describe('BigQueryToolset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should initialize and return tools properly', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(6);
    await toolset.close();
  });

  it('should filter tools with array', async () => {
    const toolset = new BigQueryToolset(['execute_sql']);
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('execute_sql');
  });

  it('should filter tools with predicate and readonly_context', async () => {
    const toolset = new BigQueryToolset(
      (tool) => tool.name === 'list_dataset_ids',
    );
    const tools = await toolset.getTools(
      new ReadonlyContext(createInvocationContext()),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_dataset_ids');
  });

  it('should return all tools when a predicate is set but no context is given', async () => {
    // `getTools()` may legitimately be called without a context. A predicate
    // cannot run without one, so all tools are returned rather than invoking
    // the predicate with a fake context that would throw on `state` access.
    const toolset = new BigQueryToolset((tool, context) => {
      return context.agentName === 'test_agent' && tool.name === 'get_job_info';
    });
    expect(await toolset.getTools()).toHaveLength(6);
    expect(
      await toolset.getTools(new ReadonlyContext(createInvocationContext())),
    ).toHaveLength(1);
  });

  it('should execute get_dataset_info properly', async () => {
    const spy = vi
      .spyOn(metadataTools, 'getDatasetInfo')
      .mockResolvedValue({id: 'd'});
    const toolset = new BigQueryToolset(['get_dataset_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {project_id: 'p', dataset_id: 'd'},
      toolContext: createToolContext(),
    });
    expect(spy).toHaveBeenCalledWith('p', 'd', undefined, {});
  });

  it('should execute list_dataset_ids properly', async () => {
    const spy = vi
      .spyOn(metadataTools, 'listDatasetIds')
      .mockResolvedValue({status: 'SUCCESS', datasets: []});
    const toolset = new BigQueryToolset(['list_dataset_ids']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {project_id: 'p'},
      toolContext: createToolContext(),
    });
    expect(spy).toHaveBeenCalledWith('p', undefined, {});
  });

  it('should execute get_table_info properly', async () => {
    const spy = vi
      .spyOn(metadataTools, 'getTableInfo')
      .mockResolvedValue({id: 't'});
    const toolset = new BigQueryToolset(['get_table_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {project_id: 'p', dataset_id: 'd', table_id: 't'},
      toolContext: createToolContext(),
    });
    expect(spy).toHaveBeenCalledWith('p', 'd', 't', undefined, {});
  });

  it('should execute list_table_ids properly', async () => {
    const spy = vi
      .spyOn(metadataTools, 'listTableIds')
      .mockResolvedValue({status: 'SUCCESS', tables: []});
    const toolset = new BigQueryToolset(['list_table_ids']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {project_id: 'p', dataset_id: 'd'},
      toolContext: createToolContext(),
    });
    expect(spy).toHaveBeenCalledWith('p', 'd', undefined, {});
  });

  it('should execute get_job_info properly', async () => {
    const spy = vi
      .spyOn(metadataTools, 'getJobInfo')
      .mockResolvedValue({id: 'j'});
    const toolset = new BigQueryToolset(['get_job_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({
      args: {project_id: 'p', job_id: 'j'},
      toolContext: createToolContext(),
    });
    expect(spy).toHaveBeenCalledWith('p', 'j', undefined, undefined, {});
  });

  it('should execute execute_sql properly', async () => {
    const spy = vi
      .spyOn(queryTools, 'executeSql')
      .mockResolvedValue({status: 'SUCCESS', rows: []});
    const toolset = new BigQueryToolset(['execute_sql']);
    const [tool] = await toolset.getTools();
    const toolContext = createToolContext();
    await tool.runAsync({
      args: {project_id: 'p', query: 'sql'},
      toolContext,
    });
    expect(spy).toHaveBeenCalledWith(
      'p',
      'sql',
      undefined,
      {},
      toolContext,
      false,
    );
  });
});
