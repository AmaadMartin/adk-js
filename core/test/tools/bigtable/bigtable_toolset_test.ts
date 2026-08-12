/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {BaseTool} from '../../../src/tools/base_tool.js';
import {BigtableToolset} from '../../../src/tools/bigtable/bigtable_toolset.js';
import {
  BIGTABLE_DEFAULT_SCOPE,
  DEFAULT_BIGTABLE_TOOL_NAME_PREFIX,
} from '../../../src/tools/bigtable/index.js';
import * as metadataTool from '../../../src/tools/bigtable/metadata_tool.js';
import * as queryTool from '../../../src/tools/bigtable/query_tool.js';
import {logger} from '../../../src/utils/logger.js';

import type {FakeBigtable} from './bigtable_test_utils.js';

const {bigtableMock, BigtableMock} = vi.hoisted(() => {
  const bigtableMock: FakeBigtable = {
    projectId: 'p',
    getInstances: vi.fn(),
    instance: vi.fn(),
    close: vi.fn(async () => []),
  };
  return {bigtableMock, BigtableMock: vi.fn(() => bigtableMock)};
});

vi.mock('@google-cloud/bigtable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/bigtable')>()),
  Bigtable: BigtableMock,
}));

vi.mock('../../../src/tools/bigtable/query_tool.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/tools/bigtable/query_tool.js')
    >();
  return {...actual, executeSql: vi.fn()};
});

vi.mock(
  '../../../src/tools/bigtable/metadata_tool.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/tools/bigtable/metadata_tool.js')
      >();
    return {
      ...actual,
      listInstances: vi.fn(),
      getInstanceInfo: vi.fn(),
      listTables: vi.fn(),
      getTableInfo: vi.fn(),
      listClusters: vi.fn(),
      getClusterInfo: vi.fn(),
    };
  },
);

function createContext(
  state: Record<string, unknown> = {},
  userId = 'test-user',
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 's1', appName: 'app', state, userId}),
      pluginManager: new PluginManager([]),
    }),
  });
}

function findTool(tools: BaseTool[], name: string): BaseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(
      `No tool named ${name}; got ${tools.map((t) => t.name).join(', ')}`,
    );
  }
  return tool;
}

describe('BigtableToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryTool.executeSql).mockResolvedValue({
      status: 'SUCCESS',
      rows: [],
    });
  });

  it('exports the toolset surface from the package barrel', () => {
    expect(DEFAULT_BIGTABLE_TOOL_NAME_PREFIX).toBe('bigtable');
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('prefixes every tool name', async () => {
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

  it('honours a custom prefix and an empty one', async () => {
    const custom = await new BigtableToolset({prefix: 'bt'}).getTools();
    expect(custom.map((tool) => tool.name)).toContain('bt_execute_sql');

    const unprefixed = await new BigtableToolset({prefix: ''}).getTools();
    expect(unprefixed.map((tool) => tool.name)).toContain('execute_sql');
  });

  it('adds the parameterized tool when view parameters are configured', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id'],
    }).getTools();

    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name)).toContain(
      'bigtable_execute_sql_parameterized',
    );
  });

  it('does not expose view parameters to the model', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id'],
    }).getTools();

    for (const name of [
      'bigtable_execute_sql',
      'bigtable_execute_sql_parameterized',
    ]) {
      const declaration = findTool(tools, name)._getDeclaration();
      expect(
        Object.keys(declaration?.parameters?.properties ?? {}),
      ).not.toContain('_viewParameters');
    }
  });

  it('resolves view parameters from the invocation, not from the model', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id', 'state_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {
        projectId: 'p',
        instanceId: 'i',
        query: 'Q',
        parameters: {user_id: 'attacker'},
      },
      toolContext: createContext({state_id: 'CA'}, 'alice123'),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(bigtableMock, {
      instanceId: 'i',
      query: 'Q',
      parameters: {user_id: 'attacker'},
      parameterTypes: undefined,
      viewParameters: {user_id: 'alice123', state_id: 'CA'},
      settings: undefined,
    });
  });

  it('omits view parameters that are absent from session state', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['tenant_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext(),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({viewParameters: {}}),
    );
  });

  it('skips view parameters whose state value is not a query parameter', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id', 'tenants', 'profile'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext(
        {tenants: ['a', 'b'], profile: {nested: true}},
        'alice123',
      ),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({
        viewParameters: {user_id: 'alice123', tenants: ['a', 'b']},
      }),
    );
  });

  it('wires every metadata tool to its implementation', async () => {
    const tools = await new BigtableToolset().getTools();
    const request = {
      args: {projectId: 'p', instanceId: 'i', tableId: 't', clusterId: 'c'},
      toolContext: createContext(),
    };

    await findTool(tools, 'bigtable_list_instances').runAsync(request);
    expect(metadataTool.listInstances).toHaveBeenCalledWith(bigtableMock);

    await findTool(tools, 'bigtable_get_instance_info').runAsync(request);
    expect(metadataTool.getInstanceInfo).toHaveBeenCalledWith(
      bigtableMock,
      'i',
    );

    await findTool(tools, 'bigtable_list_tables').runAsync(request);
    expect(metadataTool.listTables).toHaveBeenCalledWith(bigtableMock, 'i');

    await findTool(tools, 'bigtable_get_table_info').runAsync(request);
    expect(metadataTool.getTableInfo).toHaveBeenCalledWith(
      bigtableMock,
      'i',
      't',
    );

    await findTool(tools, 'bigtable_list_clusters').runAsync(request);
    expect(metadataTool.listClusters).toHaveBeenCalledWith(bigtableMock, 'i');

    await findTool(tools, 'bigtable_get_cluster_info').runAsync(request);
    expect(metadataTool.getClusterInfo).toHaveBeenCalledWith(
      bigtableMock,
      'i',
      'c',
    );
  });

  it('applies a tool filter', async () => {
    const tools = await new BigtableToolset({
      toolFilter: ['bigtable_execute_sql'],
    }).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['bigtable_execute_sql']);
  });

  it('forwards execute_sql arguments without any view parameters', async () => {
    const tools = await new BigtableToolset().getTools();

    await findTool(tools, 'bigtable_execute_sql').runAsync({
      args: {
        projectId: 'p',
        instanceId: 'i',
        query: 'Q',
        parameterTypes: {name: 'string'},
      },
      toolContext: createContext({user_id: 'alice123'}),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(bigtableMock, {
      instanceId: 'i',
      query: 'Q',
      parameters: undefined,
      parameterTypes: {name: 'string'},
      settings: undefined,
    });
  });

  it('reuses one client per project and closes it', async () => {
    const toolset = new BigtableToolset();
    const tools = await toolset.getTools();
    const request = {
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext(),
    };

    await findTool(tools, 'bigtable_execute_sql').runAsync(request);
    await findTool(tools, 'bigtable_execute_sql').runAsync(request);
    expect(BigtableMock).toHaveBeenCalledTimes(1);

    await toolset.close();
    expect(bigtableMock.close).toHaveBeenCalledTimes(1);
  });
  it('resolves user_id from the invocation when session state has none', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext({}, 'authenticated-user-999'),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({
        viewParameters: {user_id: 'authenticated-user-999'},
      }),
    );
  });

  it('keeps session state from overriding an invocation-backed parameter', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext({user_id: 'escalated'}, 'real-user'),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({viewParameters: {user_id: 'real-user'}}),
    );
  });

  it('resolves every invocation-backed parameter under both spellings', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: [
        'user_id',
        'userId',
        'session_id',
        'sessionId',
        'invocation_id',
        'invocationId',
        'agent_name',
        'agentName',
      ],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext({}, 'alice123'),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({
        viewParameters: {
          user_id: 'alice123',
          userId: 'alice123',
          session_id: 's1',
          sessionId: 's1',
          invocation_id: 'test-invocation',
          invocationId: 'test-invocation',
          agent_name: 'test_agent',
          agentName: 'test_agent',
        },
      }),
    );
  });

  it('falls back to session state for a parameter the invocation does not answer', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['tenant_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext({tenant_id: 'tenant-7'}),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({viewParameters: {tenant_id: 'tenant-7'}}),
    );
  });

  it('mixes invocation-backed and state-backed parameters in one call', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id', 'tenant_id', 'agent_id'],
    }).getTools();

    await findTool(tools, 'bigtable_execute_sql_parameterized').runAsync({
      args: {projectId: 'p', instanceId: 'i', query: 'Q'},
      toolContext: createContext(
        {tenant_id: 'tenant-7', agent_id: 'agent-3'},
        'alice123',
      ),
    });

    expect(queryTool.executeSql).toHaveBeenCalledWith(
      bigtableMock,
      expect.objectContaining({
        viewParameters: {
          user_id: 'alice123',
          tenant_id: 'tenant-7',
          agent_id: 'agent-3',
        },
      }),
    );
  });

  it('gives the parameterized tool the same declaration as execute_sql', async () => {
    const tools = await new BigtableToolset({
      viewParameterNames: ['user_id', 'tenant_id'],
    }).getTools();

    const parameterized = findTool(
      tools,
      'bigtable_execute_sql_parameterized',
    )._getDeclaration()?.parameters;

    expect(parameterized).toEqual(
      findTool(tools, 'bigtable_execute_sql')._getDeclaration()?.parameters,
    );
    expect(JSON.stringify(parameterized)).not.toContain('user_id');
    expect(JSON.stringify(parameterized)).not.toContain('tenant_id');
  });

  it('applies a ToolPredicate filter when a context is supplied', async () => {
    const toolset = new BigtableToolset({
      toolFilter: (tool) => tool.name.endsWith('_list_tables'),
    });

    const tools = await toolset.getTools(createContext());

    expect(tools.map((tool) => tool.name)).toEqual(['bigtable_list_tables']);
  });

  it('warns and keeps every tool when a ToolPredicate has no context', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolset = new BigtableToolset({
      toolFilter: (tool) => tool.name.endsWith('_list_tables'),
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(7);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('without a ReadonlyContext'),
    );
  });

  it('ignores unknown names in a tool filter', async () => {
    const tools = await new BigtableToolset({
      toolFilter: ['bigtable_list_tables', 'bigtable_not_a_tool'],
    }).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['bigtable_list_tables']);
  });

  it('returns no tools when every filtered name is unknown', async () => {
    const tools = await new BigtableToolset({
      toolFilter: ['bigtable_not_a_tool'],
    }).getTools(createContext());

    expect(tools).toEqual([]);
  });

  it('closes cleanly when no tool was ever invoked', async () => {
    await expect(new BigtableToolset().close()).resolves.toBeUndefined();
  });
});
