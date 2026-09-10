/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/tools/data_agent/test_data_agent_toolset.py`. The ported
 * cases keep their Python names.
 *
 * The Python `isinstance(tool, GoogleTool)` assertions become `isFunctionTool`
 * here: `GoogleTool` is not on this branch, so the tools are `FunctionTool`
 * instances built by `createDataAgentTool`. The count and the names are the
 * same.
 */

import {
  BaseTool,
  DataAgentCredentialsConfig,
  DataAgentToolset,
  isFunctionTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// Not part of the public entry point: the toolset resolves the config itself,
// so the resolver is imported from the source it lives in.
import {resolveDataAgentToolConfig} from '../../../src/tools/data_agent/config.js';
import {makeToolContext} from './data_agent_test_utils.js';

const READ_TOOL_NAMES = [
  'list_accessible_data_agents',
  'get_data_agent_info',
  'ask_data_agent',
];

const MUTATION_TOOL_NAMES = [
  'create_data_agent',
  'delete_data_agent',
  'update_data_agent',
];

/** The simplest valid credentials config: an OAuth client for each end user. */
function credentialsConfig(): DataAgentCredentialsConfig {
  return {clientId: 'abc', clientSecret: 'def'};
}

/** The names of the tools a toolset exposes. */
function namesOf(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('DataAgentToolset, ported from test_data_agent_toolset.py', () => {
  it('test_data_agent_toolset_tools_default', async () => {
    const toolset = new DataAgentToolset({
      credentialsConfig: credentialsConfig(),
      dataAgentToolConfig: undefined,
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(3);
    expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
    expect(new Set(namesOf(tools))).toEqual(new Set(READ_TOOL_NAMES));
    // The toolset runs with the same defaults `DataAgentToolConfig()` gives.
    expect(resolveDataAgentToolConfig()).toEqual({
      location: undefined,
      apiEndpoint: undefined,
      maxQueryResultRows: 50,
      dataAgentModificationTimeoutSeconds: 60,
      dataAgentModificationPollIntervalSeconds: 2,
      enableDataAgentModification: false,
    });
  });

  it('test_data_agent_toolset_tools_with_mutation_enabled', async () => {
    const toolset = new DataAgentToolset({
      credentialsConfig: credentialsConfig(),
      dataAgentToolConfig: {enableDataAgentModification: true},
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(6);
    expect(new Set(namesOf(tools))).toEqual(
      new Set([...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES]),
    );
  });

  it.each([
    {id: 'None', selectedTools: [] as string[]},
    {
      id: 'list_and_get',
      selectedTools: ['list_accessible_data_agents', 'get_data_agent_info'],
    },
    {id: 'ask', selectedTools: ['ask_data_agent']},
    {id: 'create', selectedTools: ['create_data_agent']},
    {id: 'update', selectedTools: ['update_data_agent']},
    {id: 'delete', selectedTools: ['delete_data_agent']},
  ])(
    'test_data_agent_toolset_tools_selective [$id]',
    async ({selectedTools}) => {
      const toolset = new DataAgentToolset({
        credentialsConfig: credentialsConfig(),
        toolFilter: selectedTools,
        dataAgentToolConfig: {enableDataAgentModification: true},
      });

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(selectedTools.length);
      expect(tools.every((tool) => isFunctionTool(tool))).toBe(true);
      expect(new Set(namesOf(tools))).toEqual(new Set(selectedTools));
    },
  );

  it.each([
    {id: 'all-unknown', selectedTools: ['unknown'], returnedTools: []},
    {
      id: 'mixed-known-unknown',
      selectedTools: ['unknown', 'ask_data_agent'],
      returnedTools: ['ask_data_agent'],
    },
  ])(
    'test_data_agent_toolset_unknown_tool [$id]',
    async ({selectedTools, returnedTools}) => {
      const toolset = new DataAgentToolset({
        credentialsConfig: credentialsConfig(),
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(returnedTools.length);
      expect(new Set(namesOf(tools))).toEqual(new Set(returnedTools));
    },
  );

  it('test_data_agent_toolset_tools_selective_modification_disabled', async () => {
    const toolset = new DataAgentToolset({
      credentialsConfig: credentialsConfig(),
      dataAgentToolConfig: {enableDataAgentModification: false},
      toolFilter: MUTATION_TOOL_NAMES,
    });

    expect(await toolset.getTools()).toHaveLength(0);
  });
});

describe('DataAgentToolset', () => {
  it('needs no credentials config', async () => {
    const toolset = new DataAgentToolset();
    expect(namesOf(await toolset.getTools())).toEqual(READ_TOOL_NAMES);
  });

  it('rejects a credentials config naming two sources', () => {
    expect(
      () =>
        new DataAgentToolset({
          credentialsConfig: {
            externalAccessTokenKey: 'token',
            clientId: 'abc',
            clientSecret: 'def',
          },
        }),
    ).toThrow(
      'If external_access_token_key is provided, client_id, client_secret,' +
        ' and scopes must not be provided.',
    );
  });

  it('rejects a modification timeout that is not positive', () => {
    expect(
      () =>
        new DataAgentToolset({
          dataAgentToolConfig: {dataAgentModificationTimeoutSeconds: 0},
        }),
    ).toThrow('dataAgentModificationTimeoutSeconds must be greater than zero');
  });

  it('applies a predicate filter when it is given a context', async () => {
    const toolset = new DataAgentToolset({
      toolFilter: (tool) => tool.name === 'ask_data_agent',
    });

    const tools = await toolset.getTools(makeToolContext());

    expect(namesOf(tools)).toEqual(['ask_data_agent']);
  });

  it('selects nothing for an empty filter, even with a context', async () => {
    // The inherited `isToolSelected` reads an empty array as "no filter" and
    // would answer with every tool; this toolset follows adk-python instead.
    const toolset = new DataAgentToolset({toolFilter: []});

    expect(await toolset.getTools(makeToolContext())).toHaveLength(0);
  });

  it('selects nothing for a filter of unknown names, with a context', async () => {
    const toolset = new DataAgentToolset({toolFilter: ['unknown']});

    expect(await toolset.getTools(makeToolContext())).toHaveLength(0);
  });

  it('applies a name filter when it is given a context', async () => {
    const toolset = new DataAgentToolset({toolFilter: ['ask_data_agent']});

    const tools = await toolset.getTools(makeToolContext());

    expect(namesOf(tools)).toEqual(['ask_data_agent']);
  });

  it('applies a name filter when it has no context', async () => {
    const toolset = new DataAgentToolset({toolFilter: ['get_data_agent_info']});
    expect(namesOf(await toolset.getTools())).toEqual(['get_data_agent_info']);
  });

  it('exposes every tool to a predicate it cannot run', async () => {
    const toolset = new DataAgentToolset({toolFilter: () => false});
    expect(namesOf(await toolset.getTools())).toEqual(READ_TOOL_NAMES);
  });

  it('closes without holding anything to release', async () => {
    const toolset = new DataAgentToolset();
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
