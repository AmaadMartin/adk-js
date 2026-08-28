/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, isFunctionTool, SpannerAdminToolset} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  answered,
  completedOperation,
  DatabaseAdminClientMock,
  fakeDatabaseAdmin,
  fakeInstanceAdmin,
  FUNCTION_CALL_ID,
  InstanceAdminClientMock,
  makeToolContext,
  resetSpannerFakes,
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

/** The two tools that provision a billable resource. */
const CREATE_TOOL_NAMES = [
  'spanner_create_instance',
  'spanner_create_database',
];

function toolNames(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

async function getTool(name: string): Promise<BaseTool> {
  const tools = await new SpannerAdminToolset().getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`toolset does not expose ${name}`);
  }
  return tool;
}

describe('SpannerAdminToolset', () => {
  beforeEach(() => {
    resetSpannerFakes();
  });

  it('exposes the seven prefixed admin tools by default', async () => {
    const tools = await new SpannerAdminToolset().getTools();

    expect(toolNames(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
  });

  it('returns only the tools named in a string filter', async () => {
    const toolset = new SpannerAdminToolset({
      toolFilter: ['spanner_list_instances'],
    });

    expect(toolNames(await toolset.getTools())).toEqual([
      'spanner_list_instances',
    ]);
  });

  it('narrows the tools with a predicate filter', async () => {
    const toolset = new SpannerAdminToolset({
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
    const toolset = new SpannerAdminToolset({
      toolFilter: () => false,
    });

    expect(await toolset.getTools()).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it('treats an empty filter as no filter', async () => {
    const toolset = new SpannerAdminToolset({toolFilter: []});

    expect(await toolset.getTools(makeToolContext())).toHaveLength(
      ALL_TOOL_NAMES.length,
    );
  });

  it('declares only the model-facing parameters of each tool', async () => {
    const tools = await new SpannerAdminToolset().getTools();

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
      const tools = await new SpannerAdminToolset().getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        expect.fail(`toolset does not expose ${name}`);
      }

      expect(tool._getDeclaration()?.description).toContain(
        'billable Google Cloud resource',
      );
    },
  );

  describe('confirmation gate', () => {
    it.each(CREATE_TOOL_NAMES)('%s asks the user to confirm', async (name) => {
      const tool = await getTool(name);

      expect(await tool.checkRequireConfirmation({}, makeToolContext())).toBe(
        true,
      );
    });

    it.each(ALL_TOOL_NAMES.filter((name) => !CREATE_TOOL_NAMES.includes(name)))(
      '%s runs without confirmation',
      async (name) => {
        const tool = await getTool(name);

        expect(await tool.checkRequireConfirmation({}, makeToolContext())).toBe(
          false,
        );
      },
    );

    it('does not reach the client until the user confirms', async () => {
      const tool = await getTool('spanner_create_database');
      const context = makeToolContext();

      const result = await tool.runAsync({
        args: {
          project_id: 'my-project',
          instance_id: 'my-instance',
          database_id: 'my-db',
        },
        toolContext: context,
      });

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(fakeDatabaseAdmin.createDatabase).not.toHaveBeenCalled();
      expect(
        context.actions.requestedToolConfirmations[FUNCTION_CALL_ID],
      ).toBeDefined();
    });

    it('creates the database once the user confirms', async () => {
      fakeDatabaseAdmin.createDatabase.mockResolvedValue([
        completedOperation(),
      ]);
      const tool = await getTool('spanner_create_database');

      const result = await tool.runAsync({
        args: {
          project_id: 'my-project',
          instance_id: 'my-instance',
          database_id: 'my-db',
        },
        toolContext: makeToolContext(answered(true)),
      });

      expect(result).toEqual({status: 'SUCCESS'});
      expect(fakeDatabaseAdmin.createDatabase).toHaveBeenCalledTimes(1);
    });

    it('does not create the database when the user rejects', async () => {
      const tool = await getTool('spanner_create_database');

      const result = await tool.runAsync({
        args: {
          project_id: 'my-project',
          instance_id: 'my-instance',
          database_id: 'my-db',
        },
        toolContext: makeToolContext(answered(false)),
      });

      expect(result).toEqual({error: 'This tool call is rejected.'});
      expect(fakeDatabaseAdmin.createDatabase).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('releases both admin clients once a tool has run', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);
      const toolset = new SpannerAdminToolset();
      const [listInstances] = await toolset.getTools();
      await listInstances.runAsync({
        args: {project_id: 'my-project'},
        toolContext: makeToolContext(),
      });

      await toolset.close();

      expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
      expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
    });

    it('serves the turn after the one the runner closed', async () => {
      // Constructing a gax client gives a live one, and closing it makes every
      // later call reject. `Runner` closes every toolset at the end of a turn,
      // so the second turn only works if the toolset built a new client.
      InstanceAdminClientMock.mockImplementation(() => {
        fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);
        return fakeInstanceAdmin;
      });
      fakeInstanceAdmin.close.mockImplementation(async () => {
        fakeInstanceAdmin.listInstances.mockRejectedValue(
          new Error('The client has already been closed.'),
        );
      });
      const toolset = new SpannerAdminToolset();
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

    it('does not build a client when no tool ever ran', async () => {
      await new SpannerAdminToolset().close();

      expect(InstanceAdminClientMock).not.toHaveBeenCalled();
      expect(DatabaseAdminClientMock).not.toHaveBeenCalled();
    });

    it('can be called twice', async () => {
      const toolset = new SpannerAdminToolset();

      await toolset.close();
      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });
});
