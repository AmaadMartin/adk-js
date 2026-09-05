/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/tools/spanner/test_admin_toolset.py`, read from
 * google/adk-python `main`. The titles below are descriptive, matching the
 * eleven sibling Spanner test files; this table maps them back:
 *
 * | Python test | Title here |
 * | --- | --- |
 * | `test_spanner_toolset_tools_default` | "exposes seven tools by default" |
 * | `test_spanner_admin_toolset_selective` | "keeps only the prefixed names it lists" |
 *
 * The `_tool_settings` half of `test_spanner_toolset_tools_default` is not
 * ported: it reads a private member, and `SpannerAdminToolset` takes no
 * settings option because no admin tool reads one.
 */

import {BaseTool, ReadonlyContext} from '@google/adk';
import {SpannerAdminToolset} from '@google/adk/tools/spanner';
import {describe, expect, it} from 'vitest';
import {makeToolContext, testCredentialsConfig} from './spanner_test_utils.js';

/** Arguments every tool's schema accepts, so the gate is what is measured. */
const CREATE_ARGS = {
  project_id: 'p',
  instance_id: 'i',
  config_id: 'c',
  display_name: 'Test',
  database_id: 'db',
};

/** The seven tools, in the order adk-python's `get_tools` builds them. */
const ADMIN_TOOL_NAMES = [
  'spanner_create_database',
  'spanner_list_instances',
  'spanner_get_instance',
  'spanner_list_databases',
  'spanner_create_instance',
  'spanner_list_instance_configs',
  'spanner_get_instance_config',
];

function makeToolset(
  toolFilter?: SpannerAdminToolset['toolFilter'],
): SpannerAdminToolset {
  return new SpannerAdminToolset({
    credentialsConfig: testCredentialsConfig(),
    toolFilter,
  });
}

async function toolNames(
  toolset: SpannerAdminToolset,
  context?: ReadonlyContext,
): Promise<string[]> {
  return (await toolset.getTools(context)).map((tool) => tool.name);
}

describe('SpannerAdminToolset', () => {
  it('exposes seven tools by default', async () => {
    expect(await toolNames(makeToolset())).toEqual(ADMIN_TOOL_NAMES);
  });

  it('describes every tool it exposes', async () => {
    const tools = await makeToolset().getTools();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('warns that the two create tools provision billable resources', async () => {
    const tools = await makeToolset().getTools();
    const writeTools = tools.filter((tool) =>
      ['spanner_create_instance', 'spanner_create_database'].includes(
        tool.name,
      ),
    );

    expect(writeTools).toHaveLength(2);
    for (const tool of writeTools) {
      expect(tool.description).toMatch(/billable|billed/);
    }
  });

  it('gates the two create tools behind a confirmation', async () => {
    const tools = await makeToolset().getTools();
    const gated: Record<string, boolean> = {};
    for (const tool of tools) {
      gated[tool.name] = await tool.checkRequireConfirmation(
        CREATE_ARGS,
        makeToolContext(),
      );
    }

    expect(gated).toEqual({
      spanner_create_database: true,
      spanner_create_instance: true,
      spanner_get_instance: false,
      spanner_get_instance_config: false,
      spanner_list_databases: false,
      spanner_list_instance_configs: false,
      spanner_list_instances: false,
    });
  });

  it('rejects credentials naming no source', () => {
    expect(
      () => new SpannerAdminToolset({credentialsConfig: {clientId: 'id'}}),
    ).toThrow(/Must provide one of credentials/);
  });

  it('accepts an OAuth client id and secret', () => {
    expect(
      () =>
        new SpannerAdminToolset({
          credentialsConfig: {clientId: 'id', clientSecret: 'secret'},
        }),
    ).not.toThrow();
  });

  it('closes without holding a resource', async () => {
    await expect(makeToolset().close()).resolves.toBeUndefined();
  });

  describe('the tool filter', () => {
    it('keeps only the prefixed names it lists', async () => {
      expect(await toolNames(makeToolset(['spanner_list_instances']))).toEqual([
        'spanner_list_instances',
      ]);
    });

    it('returns no tool when it is empty, as adk-python does', async () => {
      expect(await toolNames(makeToolset([]))).toEqual([]);
    });

    it('returns no tool when it is empty and a context is given', async () => {
      expect(await toolNames(makeToolset([]), makeToolContext())).toEqual([]);
    });

    it('returns every tool when the option is absent', async () => {
      expect(await toolNames(makeToolset())).toHaveLength(7);
    });

    it('returns every tool when the option is absent and a context is given', async () => {
      expect(await toolNames(makeToolset(), makeToolContext())).toEqual(
        ADMIN_TOOL_NAMES,
      );
    });

    it('drops a name no tool carries', async () => {
      expect(await toolNames(makeToolset(['unknown']))).toEqual([]);
    });

    it('does not match the unprefixed adk-python name', async () => {
      expect(await toolNames(makeToolset(['list_instances']))).toEqual([]);
    });

    it('applies a name filter with a context too', async () => {
      expect(
        await toolNames(
          makeToolset(['spanner_get_instance']),
          makeToolContext(),
        ),
      ).toEqual(['spanner_get_instance']);
    });

    it('applies a predicate when there is a context', async () => {
      const readOnly = (tool: BaseTool) => !tool.name.includes('_create_');

      expect(await toolNames(makeToolset(readOnly), makeToolContext())).toEqual(
        [
          'spanner_list_instances',
          'spanner_get_instance',
          'spanner_list_databases',
          'spanner_list_instance_configs',
          'spanner_get_instance_config',
        ],
      );
    });

    it('returns every tool for a predicate with no context', async () => {
      const readOnly = (tool: BaseTool) => !tool.name.includes('_create_');

      expect(await toolNames(makeToolset(readOnly))).toEqual(ADMIN_TOOL_NAMES);
    });
  });
});
