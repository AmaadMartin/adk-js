/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQueryOptions} from '@google-cloud/bigquery';
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {
  BigQueryToolset,
  BigQueryToolsetOptions,
  version,
} from '@google/adk-integrations';
import {AuthClient, PassThroughClient} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** What the code under test hands to the BigQuery constructor. */
interface RecordedClientOptions {
  projectId?: string;
  authClient?: AuthClient;
  location?: string;
  userAgent?: string;
}

const bq = vi.hoisted(() => ({
  clients: [] as BigQueryOptions[],
  datasetCalls: [] as Array<{id: string; options?: object}>,
  tableCalls: [] as string[],
  jobCalls: [] as string[],
  getDatasets: vi.fn(),
  getTables: vi.fn(),
  datasetMetadata: vi.fn(),
  tableMetadata: vi.fn(),
  jobMetadata: vi.fn(),
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    constructor(options: BigQueryOptions) {
      bq.clients.push(options);
    }

    getDatasets = bq.getDatasets;

    dataset(id: string, options?: object) {
      bq.datasetCalls.push({id, options});
      return {
        getMetadata: bq.datasetMetadata,
        getTables: bq.getTables,
        table: (tableId: string) => {
          bq.tableCalls.push(tableId);
          return {getMetadata: bq.tableMetadata};
        },
      };
    }

    job(id: string) {
      bq.jobCalls.push(id);
      return {getMetadata: bq.jobMetadata};
    }
  },
}));

const USER_AGENT_BASE = `adk-bigquery-tool google-adk/${version}`;

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

async function runTool(
  options: BigQueryToolsetOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tools = await new BigQueryToolset(options).getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`the toolset exposes no tool named ${name}`);
  }
  return tool.runAsync({args, toolContext: makeContext()});
}

/** The options the single BigQuery client of this test was built with. */
function onlyClient(): RecordedClientOptions {
  expect(bq.clients).toHaveLength(1);
  return bq.clients[0];
}

beforeEach(() => {
  bq.clients.length = 0;
  bq.datasetCalls.length = 0;
  bq.tableCalls.length = 0;
  bq.jobCalls.length = 0;
  vi.clearAllMocks();
});

describe('list_dataset_ids', () => {
  it('returns the dataset ids of the project', async () => {
    bq.getDatasets.mockResolvedValue([[{id: 'austin_311'}, {id: 'baseball'}]]);

    const result = await runTool({}, 'list_dataset_ids', {
      project_id: 'bigquery-public-data',
    });

    expect(result).toEqual(['austin_311', 'baseball']);
    expect(bq.getDatasets).toHaveBeenCalledWith();
    expect(onlyClient().projectId).toBe('bigquery-public-data');
  });

  it('drops a dataset the API returned without an id', async () => {
    bq.getDatasets.mockResolvedValue([[{id: 'austin_311'}, {id: undefined}]]);

    const result = await runTool({}, 'list_dataset_ids', {
      project_id: 'bigquery-public-data',
    });

    expect(result).toEqual(['austin_311']);
  });
});

describe('get_dataset_info', () => {
  it('returns the dataset resource', async () => {
    bq.datasetMetadata.mockResolvedValue([
      {id: 'p:cdc_places', location: 'US'},
    ]);

    const result = await runTool({}, 'get_dataset_info', {
      project_id: 'bigquery-public-data',
      dataset_id: 'cdc_places',
    });

    expect(result).toEqual({id: 'p:cdc_places', location: 'US'});
  });

  it('reads a dataset owned by another project', async () => {
    bq.datasetMetadata.mockResolvedValue([{}]);

    await runTool({}, 'get_dataset_info', {
      project_id: 'bigquery-public-data',
      dataset_id: 'cdc_places',
    });

    expect(bq.datasetCalls).toEqual([{id: 'cdc_places', options: undefined}]);
    expect(onlyClient().projectId).toBe('bigquery-public-data');
  });
});

describe('list_table_ids', () => {
  it('returns the table ids of the dataset', async () => {
    bq.getTables.mockResolvedValue([[{id: 'table1'}, {id: 'table2'}]]);

    const result = await runTool({}, 'list_table_ids', {
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
    });

    expect(result).toEqual(['table1', 'table2']);
    expect(bq.datasetCalls).toEqual([
      {id: 'my_dataset_id', options: undefined},
    ]);
    expect(onlyClient().projectId).toBe('my_project_id');
  });
});

describe('get_table_info', () => {
  it('returns the table resource', async () => {
    bq.tableMetadata.mockResolvedValue([{numRows: '1000'}]);

    const result = await runTool({}, 'get_table_info', {
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      table_id: 'my_table_id',
    });

    expect(result).toEqual({numRows: '1000'});
    expect(bq.tableCalls).toEqual(['my_table_id']);
  });
});

describe('get_job_info', () => {
  it('returns the job resource', async () => {
    bq.jobMetadata.mockResolvedValue([{status: {state: 'DONE'}}]);

    const result = await runTool({}, 'get_job_info', {
      project_id: 'my_project_id',
      job_id: 'bquxjob_12345678',
    });

    expect(result).toEqual({status: {state: 'DONE'}});
    expect(bq.jobCalls).toEqual(['bquxjob_12345678']);
  });
});

describe('credentials', () => {
  it('hands the supplied credential to the BigQuery client', async () => {
    const credentials = new PassThroughClient();
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({credentials}, 'list_dataset_ids', {
      project_id: 'my_project_id',
    });

    expect(onlyClient().authClient).toBe(credentials);
  });

  it('leaves the client to find Application Default Credentials', async () => {
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({}, 'list_dataset_ids', {project_id: 'my_project_id'});

    expect(onlyClient().authClient).toBeUndefined();
  });
});

describe('client options', () => {
  it('names the tool in the user agent', async () => {
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({}, 'list_dataset_ids', {project_id: 'my_project_id'});

    expect(onlyClient().userAgent).toBe(`${USER_AGENT_BASE} list_dataset_ids`);
  });

  it('names the application before the tool in the user agent', async () => {
    bq.datasetMetadata.mockResolvedValue([{}]);

    await runTool(
      {toolConfig: {applicationName: 'bq-explorer'}},
      'get_dataset_info',
      {project_id: 'my_project_id', dataset_id: 'my_dataset_id'},
    );

    expect(onlyClient().userAgent).toBe(
      `${USER_AGENT_BASE} bq-explorer get_dataset_info`,
    );
  });

  it('leaves no double space for an empty application name', async () => {
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({toolConfig: {applicationName: ''}}, 'list_dataset_ids', {
      project_id: 'my_project_id',
    });

    expect(onlyClient().userAgent).toBe(`${USER_AGENT_BASE} list_dataset_ids`);
  });

  it('forwards the configured location', async () => {
    bq.jobMetadata.mockResolvedValue([{}]);

    await runTool({toolConfig: {location: 'US'}}, 'get_job_info', {
      project_id: 'my_project_id',
      job_id: 'job-1',
    });

    expect(onlyClient().location).toBe('US');
  });

  it('sends no location when the config names none', async () => {
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({}, 'list_dataset_ids', {project_id: 'my_project_id'});

    expect(onlyClient().location).toBeUndefined();
  });

  it('keeps the toolset prefix out of the user agent', async () => {
    bq.getDatasets.mockResolvedValue([[]]);

    await runTool({prefix: 'warehouse'}, 'warehouse_list_dataset_ids', {
      project_id: 'my_project_id',
    });

    expect(onlyClient().userAgent).toBe(`${USER_AGENT_BASE} list_dataset_ids`);
  });
});

describe('error handling', () => {
  const failures: Array<{
    name: string;
    args: Record<string, unknown>;
    reject: () => void;
  }> = [
    {
      name: 'list_dataset_ids',
      args: {project_id: 'p'},
      reject: () => bq.getDatasets.mockRejectedValue(new Error('boom')),
    },
    {
      name: 'get_dataset_info',
      args: {project_id: 'p', dataset_id: 'd'},
      reject: () => bq.datasetMetadata.mockRejectedValue(new Error('boom')),
    },
    {
      name: 'list_table_ids',
      args: {project_id: 'p', dataset_id: 'd'},
      reject: () => bq.getTables.mockRejectedValue(new Error('boom')),
    },
    {
      name: 'get_table_info',
      args: {project_id: 'p', dataset_id: 'd', table_id: 't'},
      reject: () => bq.tableMetadata.mockRejectedValue(new Error('boom')),
    },
    {
      name: 'get_job_info',
      args: {project_id: 'p', job_id: 'j'},
      reject: () => bq.jobMetadata.mockRejectedValue(new Error('boom')),
    },
  ];

  for (const failure of failures) {
    it(`returns the error payload instead of throwing from ${failure.name}`, async () => {
      failure.reject();

      const result = await runTool({}, failure.name, failure.args);

      expect(result).toEqual({status: 'ERROR', error_details: 'boom'});
    });
  }

  it('renders a rejection that is not an Error', async () => {
    bq.getDatasets.mockRejectedValue('quota exhausted');

    const result = await runTool({}, 'list_dataset_ids', {project_id: 'p'});

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'quota exhausted',
    });
  });
});
