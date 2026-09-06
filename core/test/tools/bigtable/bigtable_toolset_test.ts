/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BigtableCredentialsConfig,
  BigtableToolset,
  Context,
  DEFAULT_BIGTABLE_TOOL_NAME_PREFIX,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  createSession,
  isFunctionTool,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {GoogleToolStatus} from '../../../src/tools/google_tool.js';

import {
  type FakeBigtableData,
  fakeBigtableState,
  resetFakeBigtable,
} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', async () => ({
  Bigtable: (await import('./bigtable_fakes.js')).FakeBigtable,
}));

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';

/** The operations, as a `toolFilter` names them. */
const ALL_OPERATIONS = [
  'list_instances',
  'get_instance_info',
  'list_tables',
  'get_table_info',
  'list_clusters',
  'get_cluster_info',
  'execute_sql',
];

/** The names the model sees, once the toolset applies its prefix. */
const ALL_TOOL_NAMES = ALL_OPERATIONS.map(
  (operation) => `${DEFAULT_BIGTABLE_TOOL_NAME_PREFIX}_${operation}`,
);

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: createInvocationContext(),
    functionCallId: 'test-function-call-id',
  });
}

async function toolNames(toolset: BigtableToolset): Promise<string[]> {
  return (await toolset.getTools()).map((tool) => tool.name);
}

function withData(data: FakeBigtableData): void {
  resetFakeBigtable(data);
}

describe('BigtableToolset', () => {
  beforeEach(() => {
    resetFakeBigtable();
  });

  it('prefixes its tool names with bigtable', () => {
    expect(new BigtableToolset().prefix).toBe(
      DEFAULT_BIGTABLE_TOOL_NAME_PREFIX,
    );
    expect(DEFAULT_BIGTABLE_TOOL_NAME_PREFIX).toBe('bigtable');
  });

  it('exposes the seven Bigtable tools by default', async () => {
    const tools = await new BigtableToolset().getTools();

    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('gives the model the documented prefixed names', async () => {
    const tools = await new BigtableToolset().getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'bigtable_list_instances',
      'bigtable_get_instance_info',
      'bigtable_list_tables',
      'bigtable_get_table_info',
      'bigtable_list_clusters',
      'bigtable_get_cluster_info',
      'bigtable_execute_sql',
    ]);
  });

  it('exposes every tool when no filter is given', async () => {
    expect(await toolNames(new BigtableToolset({}))).toEqual(ALL_TOOL_NAMES);
  });

  it('exposes every tool to an invocation that supplies a context', async () => {
    const tools = await new BigtableToolset().getTools(
      new ReadonlyContext(createInvocationContext()),
    );

    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
  });

  it('exposes no tool when the filter list is empty', async () => {
    expect(await toolNames(new BigtableToolset({toolFilter: []}))).toEqual([]);
  });

  it('exposes only the metadata tools the filter names', async () => {
    const toolset = new BigtableToolset({
      toolFilter: ['list_instances', 'get_instance_info'],
    });

    expect(await toolNames(toolset)).toEqual([
      'bigtable_list_instances',
      'bigtable_get_instance_info',
    ]);
  });

  it('exposes only the table tools the filter names', async () => {
    const toolset = new BigtableToolset({
      toolFilter: ['list_tables', 'get_table_info'],
    });

    expect(await toolNames(toolset)).toEqual([
      'bigtable_list_tables',
      'bigtable_get_table_info',
    ]);
  });

  it('exposes only the query tool when the filter names it', async () => {
    const toolset = new BigtableToolset({toolFilter: ['execute_sql']});

    expect(await toolNames(toolset)).toEqual(['bigtable_execute_sql']);
  });

  it('ignores a filter entry that names no tool', async () => {
    expect(
      await toolNames(new BigtableToolset({toolFilter: ['unknown']})),
    ).toEqual([]);
    expect(
      await toolNames(
        new BigtableToolset({toolFilter: ['unknown', 'execute_sql']}),
      ),
    ).toEqual(['bigtable_execute_sql']);
  });

  it('matches a filter against the unprefixed operation name', async () => {
    const toolset = new BigtableToolset({
      toolFilter: ['bigtable_execute_sql'],
    });

    expect(await toolNames(toolset)).toEqual([]);
  });

  it('asks a predicate filter about every tool', async () => {
    const seen: string[] = [];
    const toolset = new BigtableToolset({
      toolFilter: (tool: BaseTool) => {
        seen.push(tool.name);
        return tool.name.startsWith('bigtable_list_');
      },
    });

    const tools = await toolset.getTools(
      new ReadonlyContext(createInvocationContext()),
    );

    expect(seen).toEqual(ALL_TOOL_NAMES);
    expect(tools.map((tool) => tool.name)).toEqual([
      'bigtable_list_instances',
      'bigtable_list_tables',
      'bigtable_list_clusters',
    ]);
  });

  it('exposes every tool when a predicate filter has no context to read', async () => {
    const toolset = new BigtableToolset({toolFilter: () => false});

    expect(await toolNames(toolset)).toEqual(ALL_TOOL_NAMES);
  });

  it('keeps credentials and settings out of every declaration', async () => {
    const toolset = new BigtableToolset({
      credentialsConfig: new BigtableCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      }),
      bigtableToolSettings: {maxQueryResultRows: 20},
    });

    for (const tool of await toolset.getTools()) {
      const properties = Object.keys(
        tool._getDeclaration()?.parameters?.properties ?? {},
      );
      expect(properties).not.toContain('credentials');
      expect(properties).not.toContain('settings');
    }
  });

  it('opens no client until a tool runs', async () => {
    const toolset = new BigtableToolset();

    await toolset.getTools();

    expect(fakeBigtableState.calls.constructed).toEqual([]);
  });

  it('reads the metadata a tool call asks for', async () => {
    withData({instances: [{id: INSTANCE, metadata: {state: 1, type: 1}}]});
    const [listInstancesTool] = await new BigtableToolset({
      toolFilter: ['list_instances'],
    }).getTools();

    const result = await listInstancesTool.runAsync({
      args: {projectId: PROJECT},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      results: [
        {
          projectId: PROJECT,
          instanceId: INSTANCE,
          displayName: undefined,
          state: 'READY',
          type: 'PRODUCTION',
          labels: undefined,
        },
      ],
    });
  });

  it('routes each metadata tool to its Bigtable call', async () => {
    withData({
      instanceData: {
        [INSTANCE]: {
          metadata: {state: 1},
          tables: [{id: 'test-table', name: 'tables/test-table'}],
          families: {'test-table': ['cf1']},
          clusters: [{id: 'test-cluster', metadata: {state: 1}}],
        },
      },
    });
    const tools = new Map(
      (await new BigtableToolset().getTools()).map((tool) => [tool.name, tool]),
    );
    const args = {
      projectId: PROJECT,
      instanceId: INSTANCE,
      tableId: 'test-table',
      clusterId: 'test-cluster',
    };

    const results = await Promise.all(
      [
        'bigtable_get_instance_info',
        'bigtable_list_tables',
        'bigtable_get_table_info',
        'bigtable_list_clusters',
        'bigtable_get_cluster_info',
      ].map((name) => {
        const tool = tools.get(name);
        if (!tool) {
          return expect.fail(`the toolset did not expose ${name}`);
        }
        return tool.runAsync({args, toolContext: createToolContext()});
      }),
    );

    expect(
      results.map((result) => (result as {status: string}).status),
    ).toEqual(Array(5).fill(GoogleToolStatus.SUCCESS));
  });

  it('caps a query at the row limit the settings name', async () => {
    withData({
      instanceData: {[INSTANCE]: {rows: [[['n', 1]], [['n', 2]], [['n', 3]]]}},
    });
    const [executeSqlTool] = await new BigtableToolset({
      toolFilter: ['execute_sql'],
      bigtableToolSettings: {maxQueryResultRows: 1},
    }).getTools();

    const result = await executeSqlTool.runAsync({
      args: {projectId: PROJECT, instanceId: INSTANCE, query: 'SELECT 1'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{n: 1}],
      resultIsLikelyTruncated: true,
    });
  });

  it('caps a query at 50 rows when no settings are given', async () => {
    const rows = Array.from(
      {length: 60},
      (_, index): Array<[string, number]> => [['n', index]],
    );
    withData({instanceData: {[INSTANCE]: {rows}}});
    const [executeSqlTool] = await new BigtableToolset({
      toolFilter: ['execute_sql'],
    }).getTools();

    const result = await executeSqlTool.runAsync({
      args: {projectId: PROJECT, instanceId: INSTANCE, query: 'SELECT 1'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({resultIsLikelyTruncated: true});
    expect((result as {rows: unknown[]}).rows).toHaveLength(50);
  });

  it('reports a failed call as an error result rather than throwing', async () => {
    withData({
      instanceData: {
        [INSTANCE]: {prepareError: new Error('invalid query')},
      },
    });
    const [executeSqlTool] = await new BigtableToolset({
      toolFilter: ['execute_sql'],
    }).getTools();

    const result = await executeSqlTool.runAsync({
      args: {projectId: PROJECT, instanceId: INSTANCE, query: 'SELECT bad'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      errorDetails: "Error in tool 'bigtable_execute_sql': invalid query",
    });
  });

  it('asks the end user for authorization before touching Bigtable', async () => {
    const toolContext = createToolContext();
    const [listInstancesTool] = await new BigtableToolset({
      toolFilter: ['list_instances'],
      credentialsConfig: new BigtableCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      }),
    }).getTools();

    const result = await listInstancesTool.runAsync({
      args: {projectId: PROJECT},
      toolContext,
    });

    expect(result).toContain('User authorization is required');
    expect(fakeBigtableState.calls.constructed).toEqual([]);
  });

  it('rejects a call whose arguments do not match the schema', async () => {
    const [listInstancesTool] = await new BigtableToolset({
      toolFilter: ['list_instances'],
    }).getTools();

    const result = await listInstancesTool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({status: GoogleToolStatus.ERROR});
  });

  it('reads the credentials config on every getTools call', async () => {
    const toolset = new BigtableToolset({toolFilter: ['list_instances']});

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(second[0]).not.toBe(first[0]);
    expect(second[0].name).toBe('bigtable_list_instances');
  });

  it('releases every client it opened', async () => {
    withData({instances: []});
    const [listInstancesTool] = await new BigtableToolset({
      toolFilter: ['list_instances'],
    }).getTools();
    const toolset = new BigtableToolset();
    await listInstancesTool.runAsync({
      args: {projectId: PROJECT},
      toolContext: createToolContext(),
    });

    await toolset.close();

    expect(fakeBigtableState.calls.constructed).toHaveLength(1);
  });

  it('closes the clients the tools opened', async () => {
    withData({instances: []});
    const toolset = new BigtableToolset({toolFilter: ['list_instances']});
    const [listInstancesTool] = await toolset.getTools();
    await listInstancesTool.runAsync({
      args: {projectId: PROJECT},
      toolContext: createToolContext(),
    });

    await toolset.close();

    expect(fakeBigtableState.calls.closed).toBe(1);
  });
});
