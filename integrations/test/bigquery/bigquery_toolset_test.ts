/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {BigQueryToolset} from '@google/adk-integrations';
import {PassThroughClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const ALL_TOOL_NAMES = [
  'get_dataset_info',
  'get_table_info',
  'list_dataset_ids',
  'list_table_ids',
  'get_job_info',
];

function makeReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

function names(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('BigQueryToolset', () => {
  it('exposes every metadata tool when no filter is given', async () => {
    const toolset = new BigQueryToolset();

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('accepts a pre-built auth client', async () => {
    const toolset = new BigQueryToolset({
      credentials: new PassThroughClient(),
    });

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('exposes only the dataset metadata tools the filter names', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: ['list_dataset_ids', 'get_dataset_info'],
    });

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([
      'get_dataset_info',
      'list_dataset_ids',
    ]);
  });

  it('exposes only the table metadata tools the filter names', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: ['list_table_ids', 'get_table_info'],
    });

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual(['get_table_info', 'list_table_ids']);
  });

  it('exposes no tool for a filter that names only unknown tools', async () => {
    const toolset = new BigQueryToolset({toolFilter: ['unknown']});

    const tools = await toolset.getTools();

    expect(tools).toEqual([]);
  });

  it('ignores an unknown name beside a known one', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: ['unknown', 'list_dataset_ids'],
    });

    const tools = await toolset.getTools();

    expect(names(tools)).toEqual(['list_dataset_ids']);
  });

  it('applies a name filter when getTools runs without a context', async () => {
    const toolset = new BigQueryToolset({toolFilter: ['get_job_info']});

    const tools = await toolset.getTools();

    expect(names(tools)).toEqual(['get_job_info']);
  });

  // adk-python's `_is_tool_selected` treats `tool_filter=[]` as "no tools".
  // adk-js's BaseToolset.isToolSelected documents the opposite, and this
  // toolset follows the adk-js base class.
  it('exposes every tool for an empty filter list', async () => {
    const toolset = new BigQueryToolset({toolFilter: []});

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('applies a predicate filter when a context is given', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const tools = await toolset.getTools(makeReadonlyContext());

    expect(names(tools).sort()).toEqual(['list_dataset_ids', 'list_table_ids']);
  });

  it('skips a predicate filter when no context is given', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('closes without holding a client open', async () => {
    await expect(new BigQueryToolset().close()).resolves.toBeUndefined();
  });

  it('rejects an application name that contains a space', () => {
    expect(
      () => new BigQueryToolset({toolConfig: {applicationName: 'my app'}}),
    ).toThrowError('Application name should not contain spaces.');
  });

  it('resolves its tools through an agent that lists it', async () => {
    const agent = new LlmAgent({
      name: 'bq_explorer',
      model: 'gemini-2.5-flash',
      instruction: 'Help the user understand the data available in BigQuery.',
      tools: [new BigQueryToolset({toolConfig: {location: 'US'}})],
    });

    const tools = await agent.canonicalTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('accepts an application name without a space', async () => {
    const toolset = new BigQueryToolset({
      toolConfig: {applicationName: 'my-app', location: 'US'},
    });

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('prepends the prefix to every tool name', async () => {
    const toolset = new BigQueryToolset({prefix: 'warehouse'});

    const tools = await toolset.getTools();

    expect(names(tools).sort()).toEqual(
      ALL_TOOL_NAMES.map((name) => `warehouse_${name}`).sort(),
    );
  });

  it('matches the filter against the prefixed tool name', async () => {
    const toolset = new BigQueryToolset({
      prefix: 'warehouse',
      toolFilter: ['warehouse_list_dataset_ids'],
    });

    const tools = await toolset.getTools();

    expect(names(tools)).toEqual(['warehouse_list_dataset_ids']);
  });

  it('exposes no tool when the filter names the unprefixed name', async () => {
    const toolset = new BigQueryToolset({
      prefix: 'warehouse',
      toolFilter: ['list_dataset_ids'],
    });

    const tools = await toolset.getTools();

    expect(tools).toEqual([]);
  });
});
