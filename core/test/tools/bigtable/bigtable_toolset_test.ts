/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BaseTool} from '../../../src/tools/base_tool.js';
import {BigtableToolset} from '../../../src/tools/bigtable/bigtable_toolset.js';
import {logger} from '../../../src/utils/logger.js';
import {createToolContext, FakeBigtable} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', () => ({Bigtable: FakeBigtable}));

const ALL_TOOL_NAMES = [
  'list_instances',
  'get_instance_info',
  'list_tables',
  'get_table_info',
  'list_clusters',
  'get_cluster_info',
  'execute_sql',
];

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';

function names(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('BigtableToolset', () => {
  it('returns the seven tools', async () => {
    const tools = await new BigtableToolset().getTools();

    expect(tools).toHaveLength(7);
    expect(new Set(names(tools))).toEqual(new Set(ALL_TOOL_NAMES));
  });

  it.each([
    [[], []],
    [
      ['list_instances', 'get_instance_info'],
      ['list_instances', 'get_instance_info'],
    ],
    [
      ['list_tables', 'get_table_info'],
      ['list_tables', 'get_table_info'],
    ],
    [['execute_sql'], ['execute_sql']],
  ])('exposes only the tools the filter %j names', async (filter, expected) => {
    const tools = await new BigtableToolset({toolFilter: filter}).getTools();

    expect(new Set(names(tools))).toEqual(new Set(expected));
  });

  it.each([
    [['unknown'], []],
    [['unknown', 'execute_sql'], ['execute_sql']],
  ])('ignores the unknown names in %j', async (filter, expected) => {
    const tools = await new BigtableToolset({toolFilter: filter}).getTools();

    expect(names(tools)).toEqual(expected);
  });

  it('exposes every tool when no filter is set', async () => {
    const tools = await new BigtableToolset({toolFilter: undefined}).getTools();

    expect(tools).toHaveLength(7);
  });

  it('applies a predicate filter against the context', async () => {
    const context = await createToolContext();

    const tools = await new BigtableToolset({
      toolFilter: (tool) => tool.name === 'list_tables',
    }).getTools(context);

    expect(names(tools)).toEqual(['list_tables']);
  });

  it('lists every tool when a predicate filter has no context to judge by', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const tools = await new BigtableToolset({
      toolFilter: () => false,
    }).getTools();

    expect(tools).toHaveLength(7);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot evaluate its tool filter'),
    );
    warn.mockRestore();
  });

  it('builds exactly one query tool', async () => {
    const tools = await new BigtableToolset().getTools();

    expect(names(tools).filter((name) => name === 'execute_sql')).toHaveLength(
      1,
    );
  });

  it('shows the model only the five query arguments', async () => {
    const tools = await new BigtableToolset().getTools();
    const query = tools.find((tool) => tool.name === 'execute_sql');
    if (query === undefined) {
      return expect.fail('the query tool was not built');
    }

    const properties = query._getDeclaration()?.parameters?.properties ?? {};

    expect(Object.keys(properties).sort()).toEqual([
      'instance_id',
      'parameter_types',
      'parameters',
      'project_id',
      'query',
    ]);
  });

  it('closes every client its tools opened', async () => {
    FakeBigtable.reset({instances: {[INSTANCE]: {rows: []}}});
    const toolset = new BigtableToolset();
    const tools = await toolset.getTools();
    const query = tools.find((tool) => tool.name === 'execute_sql');
    if (query === undefined) {
      return expect.fail('the query tool was not built');
    }
    await query.runAsync({
      args: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
      },
      toolContext: await createToolContext(),
    });

    await toolset.close();

    expect(FakeBigtable.created.map((client) => client.closes)).toEqual([1]);
  });
});
