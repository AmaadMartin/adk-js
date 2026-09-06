/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js behaviour the reference suite has no counterpart for: the
 * predicate filter, the write-mode description the model reads, the clients
 * the tools open, and the failure envelope every tool answers with.
 */

import {
  BaseTool,
  Context,
  GoogleToolStatus,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {toolCall} from '@google/adk/integrations/bigquery/bigquery_toolset.js';
import {
  BigQueryCredentialsConfig,
  BigQueryToolset,
  WriteMode,
  createBigQueryToolSettings,
} from '@google/adk/integrations/bigquery/index.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeState, plannedJob, resetFakes} from './bigquery_fakes.js';

const bigqueryLoaded = vi.fn();
const dataplexLoaded = vi.fn();

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  bigqueryLoaded();
  return {BigQuery: FakeBigQuery};
});

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient} = await import('./bigquery_fakes.js');
  dataplexLoaded();
  return {CatalogServiceClient: FakeCatalogServiceClient};
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

function readonlyContext(): ReadonlyContext {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session,
      pluginManager: new PluginManager([]),
    }),
  );
}

/** The tool of that name, or a failed expectation naming what was found. */
function toolNamed(tools: BaseTool[], name: string): BaseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return expect.fail(
      `no tool named ${name}; found ${tools.map((t) => t.name).join(', ')}`,
    );
  }
  return tool;
}

/** The arguments each tool needs, so every one of them can be driven. */
const TOOL_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
  get_dataset_info: {projectId: PROJECT, datasetId: 'sales'},
  get_table_info: {projectId: PROJECT, datasetId: 'sales', tableId: 'orders'},
  list_dataset_ids: {projectId: PROJECT},
  list_table_ids: {projectId: PROJECT, datasetId: 'sales'},
  get_job_info: {projectId: PROJECT, jobId: 'job-1'},
  execute_sql: {projectId: PROJECT, query: 'SELECT 1'},
  forecast: {
    projectId: PROJECT,
    historyData: 'd.t',
    timestampCol: 'ts',
    dataCol: 'v',
  },
  analyze_contribution: {
    projectId: PROJECT,
    inputData: 'd.t',
    contributionMetric: 'SUM(v)',
    dimensionIdCols: ['a'],
    isTestCol: 'is_test',
  },
  detect_anomalies: {
    projectId: PROJECT,
    historyData: 'd.t',
    timesSeriesTimestampCol: 'ts',
    timesSeriesDataCol: 'v',
  },
  ask_data_insights: {
    projectId: PROJECT,
    userQueryWithContext: 'q',
    tableReferences: [],
  },
  search_catalog: {projectId: PROJECT, prompt: 'p'},
};

describe('BigQueryToolset construction', () => {
  beforeEach(() => {
    resetFakes();
    bigqueryLoaded.mockClear();
    dataplexLoaded.mockClear();
  });

  it('builds with no arguments at all', async () => {
    const toolset = new BigQueryToolset();

    expect(await toolset.getTools()).toHaveLength(11);
  });

  it('loads neither SDK and opens no client', async () => {
    const toolset = new BigQueryToolset();
    await toolset.getTools();

    expect(bigqueryLoaded).not.toHaveBeenCalled();
    expect(dataplexLoaded).not.toHaveBeenCalled();
    expect(fakeState.bigquery.calls.constructed).toHaveLength(0);
    expect(fakeState.dataplex.calls.constructed).toHaveLength(0);
  });

  it('rejects an invalid configuration before building a tool', () => {
    expect(
      () => new BigQueryToolset({bigqueryToolConfig: {maximumBytesBilled: 1}}),
    ).toThrow('max_bytes_billed must be set >=10485760');
  });

  it('returns the tools in the same order every time', async () => {
    const toolset = new BigQueryToolset();

    const first = (await toolset.getTools()).map((tool) => tool.name);
    const second = (await toolset.getTools()).map((tool) => tool.name);

    expect(second).toEqual(first);
    expect(first[0]).toBe('get_dataset_info');
    expect(first[first.length - 1]).toBe('search_catalog');
  });

  it('is safe to close twice', async () => {
    const toolset = new BigQueryToolset();

    await expect(toolset.close()).resolves.toBeUndefined();
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});

describe('BigQueryToolset filtering', () => {
  it('admits every tool a predicate accepts, with no context', async () => {
    const toolset = new BigQueryToolset({toolFilter: () => false});

    // With no context there is nothing for a predicate to read, so the
    // toolset admits the tool rather than calling the predicate.
    expect(await toolset.getTools()).toHaveLength(11);
  });

  it('admits every tool when the caller named no filter', async () => {
    const toolset = new BigQueryToolset();

    expect(await toolset.getTools(readonlyContext())).toHaveLength(11);
  });

  it('asks the predicate once per tool when a context is given', async () => {
    const seen: string[] = [];
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => {
        seen.push(tool.name);
        return tool.name === 'execute_sql';
      },
    });

    const tools = await toolset.getTools(readonlyContext());

    expect(tools.map((tool) => tool.name)).toEqual(['execute_sql']);
    expect(seen).toHaveLength(11);
  });

  it('lets a predicate decide from the context', async () => {
    const context = readonlyContext();
    const toolset = new BigQueryToolset({
      // `ToolPredicate` takes an optional context: a caller may list the
      // tools outside an invocation, and then there is none.
      toolFilter: (_tool, readonly) => readonly?.agentName === 'a',
    });

    expect(await toolset.getTools(context)).toHaveLength(11);
  });

  it('ignores the context when the filter is a list', async () => {
    const toolset = new BigQueryToolset({toolFilter: ['get_job_info']});

    const tools = await toolset.getTools(readonlyContext());

    expect(tools.map((tool) => tool.name)).toEqual(['get_job_info']);
  });
});

describe('BigQueryToolset execute_sql description', () => {
  it('changes with the write mode', async () => {
    const descriptions = await Promise.all(
      [WriteMode.BLOCKED, WriteMode.PROTECTED, WriteMode.ALLOWED].map(
        async (writeMode) => {
          const toolset = new BigQueryToolset({
            bigqueryToolConfig: {writeMode},
          });
          const tools = await toolset.getTools();
          return toolNamed(tools, 'execute_sql').description;
        },
      ),
    );

    expect(new Set(descriptions).size).toBe(3);
    expect(descriptions[0]).toContain('Only SELECT statements are accepted');
    expect(descriptions[1]).toContain('CREATE TEMP TABLE');
    expect(descriptions[2]).toContain('Every statement is accepted');
  });
});

describe('toolCall', () => {
  it('falls back to the toolset settings when the tool carries none', () => {
    // `GoogleTool` types the injected settings optional because a tool may be
    // built without any. This toolset always supplies them, so the fallback
    // is a type narrowing; it is pinned here so it stays one.
    const fallback = createBigQueryToolSettings({maxQueryResultRows: 7});

    expect(toolCall('execute_sql', undefined, fallback).settings).toBe(
      fallback,
    );
    expect(toolCall('execute_sql', {}, fallback).settings).toBe(fallback);
  });

  it('prefers the settings the tool was built with', () => {
    const injected = createBigQueryToolSettings({maxQueryResultRows: 3});
    const fallback = createBigQueryToolSettings({maxQueryResultRows: 7});

    expect(
      toolCall('execute_sql', {settings: injected}, fallback).settings,
    ).toBe(injected);
  });
});

describe('BigQueryToolset settings binding', () => {
  it('test_get_tools_binds_distinct_settings_per_toolset', async () => {
    resetFakes({plannedJobs: [plannedJob('SELECT')], rows: []});
    const protectedTools = await new BigQueryToolset({
      bigqueryToolConfig: {
        writeMode: WriteMode.PROTECTED,
        maxQueryResultRows: 11,
      },
    }).getTools();
    const allowedTools = await new BigQueryToolset({
      bigqueryToolConfig: {
        writeMode: WriteMode.ALLOWED,
        maxQueryResultRows: 22,
      },
    }).getTools();

    await toolNamed(allowedTools, 'execute_sql').runAsync({
      args: {projectId: PROJECT, query: 'SELECT 1'},
      toolContext: makeContext(),
    });

    // The allowed toolset runs its own row cap, and does not plan the query
    // first the way the protected one would.
    expect(fakeState.bigquery.calls.queries[0].maxResults).toBe(22);
    expect(fakeState.bigquery.calls.queryJobs).toHaveLength(0);
    expect(toolNamed(protectedTools, 'execute_sql').description).not.toBe(
      toolNamed(allowedTools, 'execute_sql').description,
    );
  });
});

describe('BigQueryToolset tool calls', () => {
  beforeEach(() => {
    resetFakes(
      {
        datasetIds: ['sales'],
        datasetMetadata: {id: 'p:sales'},
        tableIds: ['orders'],
        tableMetadata: {id: 'p:sales.orders'},
        jobMetadata: {id: 'p:US.job-1'},
        plannedJobs: [plannedJob('SELECT')],
        rows: [{a: 1}],
      },
      {searchResults: []},
    );
  });

  async function runTool(
    name: string,
    args: Record<string, unknown> = TOOL_ARGUMENTS[name],
    options: ConstructorParameters<typeof BigQueryToolset>[0] = {},
  ): Promise<unknown> {
    const toolset = new BigQueryToolset(options);
    const tool = toolNamed(await toolset.getTools(), name);
    return tool.runAsync({args, toolContext: makeContext()});
  }

  it('reads dataset metadata through a BigQuery client', async () => {
    expect(await runTool('get_dataset_info')).toEqual({id: 'p:sales'});
    expect(fakeState.bigquery.calls.constructed[0]['userAgent']).toContain(
      'get_dataset_info',
    );
  });

  it('reads table metadata', async () => {
    expect(await runTool('get_table_info')).toEqual({id: 'p:sales.orders'});
  });

  it('lists dataset ids', async () => {
    expect(await runTool('list_dataset_ids')).toEqual(['sales']);
  });

  it('lists table ids', async () => {
    expect(await runTool('list_table_ids')).toEqual(['orders']);
  });

  it('reads job metadata', async () => {
    expect(await runTool('get_job_info')).toEqual({id: 'p:US.job-1'});
  });

  it('runs a read through execute_sql', async () => {
    expect(await runTool('execute_sql')).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{a: 1}],
    });
  });

  it('labels the job with the name of the tool that started it', async () => {
    await runTool('execute_sql');

    const labels = fakeState.bigquery.calls.queries[0].labels as Record<
      string,
      string
    >;
    expect(labels['adk-bigquery-tool']).toBe('execute_sql');
  });

  it('names the application in the user agent of every call', async () => {
    await runTool('list_dataset_ids', TOOL_ARGUMENTS['list_dataset_ids'], {
      bigqueryToolConfig: {applicationName: 'my-agent'},
    });

    expect(fakeState.bigquery.calls.constructed[0]['userAgent']).toContain(
      'my-agent',
    );
  });

  it('opens the BigQuery client in the configured location', async () => {
    await runTool('list_dataset_ids', TOOL_ARGUMENTS['list_dataset_ids'], {
      bigqueryToolConfig: {location: 'europe-west1'},
    });

    expect(fakeState.bigquery.calls.constructed[0]['location']).toBe(
      'europe-west1',
    );
  });

  it('closes the Dataplex client after searching', async () => {
    expect(await runTool('search_catalog')).toEqual({
      status: GoogleToolStatus.SUCCESS,
      results: [],
    });
    expect(fakeState.dataplex.calls.closed).toBe(1);
  });

  it('closes the Dataplex client when the search failed', async () => {
    resetFakes({}, {searchError: new Error('Permission denied')});

    expect(await runTool('search_catalog')).toEqual({
      status: GoogleToolStatus.ERROR,
      // `FunctionTool` names the tool that failed, so the envelope carries a
      // prefix adk-python's message does not.
      error_details: "Error in tool 'search_catalog': Permission denied",
    });
    expect(fakeState.dataplex.calls.closed).toBe(1);
  });

  it('runs forecast against the BigQuery client', async () => {
    expect(await runTool('forecast')).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{a: 1}],
    });
  });

  it('refuses analyze_contribution while writes are blocked', async () => {
    expect(await runTool('analyze_contribution')).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details:
        "Error in tool 'analyze_contribution': analyze_contribution is not" +
        ' allowed in this session.',
    });
  });

  it('refuses detect_anomalies while writes are blocked', async () => {
    expect(await runTool('detect_anomalies')).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details:
        "Error in tool 'detect_anomalies': anomaly detection is not allowed in" +
        ' this session.',
    });
  });
});

describe('BigQueryToolset failure envelope', () => {
  const names = Object.keys(TOOL_ARGUMENTS);

  it.each(names)(
    '%s answers a structured error instead of throwing',
    async (name) => {
      // Every SDK call fails, so each tool takes its failure path. A
      // `GoogleTool` reports that as a result; a plain `FunctionTool` would
      // let it propagate.
      resetFakes(
        {
          plannedJobs: [plannedJob('SELECT')],
          errors: {
            getDatasets: new Error('Access Denied'),
            getDatasetMetadata: new Error('Access Denied'),
            getTables: new Error('Access Denied'),
            getTableMetadata: new Error('Access Denied'),
            getJobMetadata: new Error('Access Denied'),
            createQueryJob: new Error('Access Denied'),
            query: new Error('Access Denied'),
          },
        },
        {searchError: new Error('Access Denied')},
      );
      const toolset = new BigQueryToolset();
      const tool = toolNamed(await toolset.getTools(), name);

      const result = await tool.runAsync({
        args: TOOL_ARGUMENTS[name],
        toolContext: makeContext(),
      });

      expect(result).toMatchObject({status: GoogleToolStatus.ERROR});
      expect(result).toHaveProperty('error_details');
    },
  );
});

describe('BigQueryToolset credentials', () => {
  beforeEach(() => {
    resetFakes({datasetIds: []});
  });

  it('asks the end user to authorize before running a tool', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: new BigQueryCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      }),
      toolFilter: ['list_dataset_ids'],
    });
    const [tool] = await toolset.getTools();

    const result = await tool.runAsync({
      args: {projectId: PROJECT},
      toolContext: makeContext(),
    });

    expect(result).toContain('User authorization is required');
    expect(fakeState.bigquery.calls.constructed).toHaveLength(0);
  });
});
