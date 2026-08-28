/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  isFunctionTool,
  SpannerAdminToolset,
  SpannerCredentialsConfig,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  DatabaseAdminClientMock,
  fakeInstanceAdmin,
  InstanceAdminClientMock,
  makeToolContext,
  resetSpannerFakes,
  testAuthClient,
  testCredentialsConfig,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner-api', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const ALL_TOOL_NAMES = [
  'spanner_list_instances',
  'spanner_get_instance',
  'spanner_list_instance_configs',
  'spanner_get_instance_config',
  'spanner_create_instance',
  'spanner_list_databases',
  'spanner_create_database',
];

/** Parameter names each tool exposes to the model. */
const EXPECTED_PARAMETERS: Record<string, string[]> = {
  spanner_list_instances: ['project_id'],
  spanner_get_instance: ['project_id', 'instance_id'],
  spanner_list_instance_configs: ['project_id'],
  spanner_get_instance_config: ['project_id', 'config_id'],
  spanner_create_instance: [
    'project_id',
    'instance_id',
    'config_id',
    'display_name',
    'nodes',
  ],
  spanner_list_databases: ['project_id', 'instance_id'],
  spanner_create_database: ['project_id', 'instance_id', 'database_id'],
};

function toolNames(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

/** A toolset wired to the simplest valid credentials config. */
function makeToolset(
  options: {
    toolFilter?: SpannerAdminToolset['toolFilter'];
    credentialsConfig?: SpannerCredentialsConfig;
  } = {},
): SpannerAdminToolset {
  return new SpannerAdminToolset({
    credentialsConfig: options.credentialsConfig ?? testCredentialsConfig(),
    toolFilter: options.toolFilter,
  });
}

describe('SpannerAdminToolset', () => {
  beforeEach(() => {
    resetSpannerFakes();
  });

  it('exposes the seven prefixed admin tools by default', async () => {
    const tools = await makeToolset().getTools();

    expect(toolNames(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('returns only the tools named in a string filter', async () => {
    const toolset = makeToolset({toolFilter: ['spanner_list_instances']});

    expect(toolNames(await toolset.getTools())).toEqual([
      'spanner_list_instances',
    ]);
  });

  it('returns no tool for a filter written without the prefix', async () => {
    const toolset = makeToolset({
      toolFilter: ['list_instances', 'get_instance'],
    });

    expect(await toolset.getTools()).toEqual([]);
  });

  it('returns no tool for a name that is only a prefix of real names', async () => {
    const toolset = makeToolset({toolFilter: ['spanner_list']});

    expect(await toolset.getTools()).toEqual([]);
  });

  it('narrows the tools with a predicate filter', async () => {
    const toolset = makeToolset({
      toolFilter: (tool) => tool.name.startsWith('spanner_list_'),
    });

    expect(toolNames(await toolset.getTools(makeToolContext())).sort()).toEqual(
      [
        'spanner_list_databases',
        'spanner_list_instance_configs',
        'spanner_list_instances',
      ],
    );
  });

  it('cannot apply a predicate filter without a context', async () => {
    const toolset = makeToolset({toolFilter: () => false});

    expect(await toolset.getTools()).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it('treats an empty filter as no filter', async () => {
    const toolset = makeToolset({toolFilter: []});

    expect(await toolset.getTools(makeToolContext())).toHaveLength(
      ALL_TOOL_NAMES.length,
    );
  });

  it('declares only the model-facing parameters of each tool', async () => {
    const tools = await makeToolset().getTools();

    for (const tool of tools) {
      const parameters = tool._getDeclaration()?.parameters;
      expect(Object.keys(parameters?.properties ?? {}).sort()).toEqual(
        [...EXPECTED_PARAMETERS[tool.name]].sort(),
      );
    }
  });

  it.each(['spanner_create_instance', 'spanner_create_database'])(
    '%s tells the model that it costs money',
    async (name) => {
      const tools = await makeToolset().getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        expect.fail(`toolset does not expose ${name}`);
      }

      expect(tool._getDeclaration()?.description).toContain(
        'billable Google Cloud resource',
      );
    },
  );

  it.each(ALL_TOOL_NAMES)(
    '%s runs without a confirmation gate, as adk-python does',
    async (name) => {
      const tools = await makeToolset().getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        expect.fail(`toolset does not expose ${name}`);
      }

      expect(await tool.checkRequireConfirmation({}, makeToolContext())).toBe(
        false,
      );
    },
  );

  describe('credentials config validation', () => {
    it('rejects an auth client combined with another source', () => {
      expect(
        () =>
          new SpannerAdminToolset({
            credentialsConfig: {
              authClient: testAuthClient(),
              clientId: 'client-id',
            },
          }),
      ).toThrow(
        'If credentials are provided, external_access_token_key, client_id,' +
          ' client_secret, and scopes must not be provided.',
      );
    });

    it('rejects an external token key combined with OAuth fields', () => {
      expect(
        () =>
          new SpannerAdminToolset({
            credentialsConfig: {
              externalAccessTokenKey: 'spanner_token',
              clientSecret: 'client-secret',
            },
          }),
      ).toThrow(
        'If external_access_token_key is provided, client_id,' +
          ' client_secret, and scopes must not be provided.',
      );
    });

    it('rejects a config that names no credential source', () => {
      expect(() => new SpannerAdminToolset({credentialsConfig: {}})).toThrow(
        'Must provide one of credentials, external_access_token_key, or' +
          ' client_id and client_secret pair.',
      );
    });

    it('accepts an OAuth client id and secret', () => {
      expect(
        () =>
          new SpannerAdminToolset({
            credentialsConfig: {
              clientId: 'client-id',
              clientSecret: 'client-secret',
            },
          }),
      ).not.toThrow();
    });
  });

  describe('close', () => {
    it('serves the turn after the one the runner closed', async () => {
      // Constructing a gax client gives a live one, and closing it makes every
      // later call reject. `Runner` closes every toolset at the end of a turn,
      // so the second turn only works if the tool built a new client.
      InstanceAdminClientMock.mockImplementation(() => {
        fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);
        return fakeInstanceAdmin;
      });
      fakeInstanceAdmin.close.mockImplementation(async () => {
        fakeInstanceAdmin.listInstances.mockRejectedValue(
          new Error('The client has already been closed.'),
        );
      });
      const toolset = makeToolset();
      const [listInstances] = await toolset.getTools();
      const runTurn = async () => {
        const result = await listInstances.runAsync({
          args: {project_id: 'my-project'},
          toolContext: makeToolContext(),
        });
        await toolset.close();
        return result;
      };
      await runTurn();

      expect(await runTurn()).toEqual({status: 'SUCCESS', results: []});
      expect(InstanceAdminClientMock).toHaveBeenCalledTimes(2);
    });

    it('builds no client of its own', async () => {
      await makeToolset().close();

      expect(InstanceAdminClientMock).not.toHaveBeenCalled();
      expect(DatabaseAdminClientMock).not.toHaveBeenCalled();
    });

    it('can be called twice', async () => {
      const toolset = makeToolset();

      await toolset.close();
      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });
});
