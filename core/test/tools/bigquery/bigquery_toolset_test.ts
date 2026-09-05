/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BigQueryCredentialsConfig,
  BigQueryToolset,
  LlmAgent,
  isBigQueryTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createToolContext} from './bigquery_test_utils.js';

const CREDENTIALS_CONFIG: BigQueryCredentialsConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const ALL_TOOL_NAMES = [
  'execute_sql',
  'get_dataset_info',
  'get_table_info',
  'list_dataset_ids',
  'list_table_ids',
];

function names(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

describe('BigQueryToolset', () => {
  it('exposes the five BigQuery tools when no filter is given', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
    });

    const tools = await toolset.getTools();

    expect(names(tools)).toEqual(ALL_TOOL_NAMES);
    expect(tools.every(isBigQueryTool)).toBe(true);
  });

  it('describes each tool for the model', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
    });

    const tools = await toolset.getTools();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const executeSql = tools.find((tool) => tool.name === 'execute_sql');
    expect(executeSql?.description).toContain('result_is_likely_truncated');
    expect(
      executeSql?._getDeclaration()?.parameters?.properties,
    ).toHaveProperty('project_id');
  });

  it.each([
    {selected: [] as string[], expected: ALL_TOOL_NAMES},
    {
      selected: ['list_dataset_ids', 'get_dataset_info'],
      expected: ['get_dataset_info', 'list_dataset_ids'],
    },
    {
      selected: ['list_table_ids', 'get_table_info'],
      expected: ['get_table_info', 'list_table_ids'],
    },
    {selected: ['execute_sql'], expected: ['execute_sql']},
  ])('honours the name filter $selected', async ({selected, expected}) => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
      toolFilter: selected,
    });

    expect(names(await toolset.getTools())).toEqual(expected);
  });

  it.each([
    {selected: ['unknown'], expected: [] as string[]},
    {selected: ['unknown', 'execute_sql'], expected: ['execute_sql']},
  ])('drops the unknown name in $selected', async ({selected, expected}) => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
      toolFilter: selected,
    });

    expect(names(await toolset.getTools())).toEqual(expected);
  });

  it('honours a predicate filter when a context is given', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const tools = await toolset.getTools(createToolContext());

    expect(names(tools)).toEqual(['list_dataset_ids', 'list_table_ids']);
  });

  it('keeps every tool when a predicate filter has no context to read', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    expect(names(await toolset.getTools())).toEqual(ALL_TOOL_NAMES);
  });

  it('applies the name filter when a context is given as well', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
      toolFilter: ['execute_sql'],
    });

    const tools = await toolset.getTools(createToolContext());

    expect(names(tools)).toEqual(['execute_sql']);
  });

  it('builds the tools without a credential configuration', async () => {
    const toolset = new BigQueryToolset();

    expect(names(await toolset.getTools())).toEqual(ALL_TOOL_NAMES);
  });

  it('accepts an existing credential instead of a client pair', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: {
        credentials: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'refresh-token',
        },
      },
    });

    expect(names(await toolset.getTools())).toEqual(ALL_TOOL_NAMES);
  });

  it('serves an LlmAgent as a tool source', async () => {
    const agent = new LlmAgent({
      name: 'bigquery_agent',
      model: 'gemini-2.5-flash',
      instruction: 'You answer questions about BigQuery data and metadata.',
      tools: [new BigQueryToolset({credentialsConfig: CREDENTIALS_CONFIG})],
    });

    expect(names(await agent.canonicalTools())).toEqual(ALL_TOOL_NAMES);
  });

  it('closes without error', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: CREDENTIALS_CONFIG,
    });

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
