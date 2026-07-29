/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigtableToolset,
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {afterAll, describe, expect, it} from 'vitest';

/**
 * Exercises the Bigtable toolset against a real project.
 *
 * Skipped unless `BIGTABLE_E2E_PROJECT_ID` is set, because it needs
 * application default credentials and a live instance. Run it with:
 *
 * ```
 * BIGTABLE_E2E_PROJECT_ID=my-project npm run test:e2e
 * ```
 */
const projectId = process.env['BIGTABLE_E2E_PROJECT_ID'];

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'bigtable-e2e',
      agent: new LlmAgent({name: 'bigtable_e2e_agent'}),
      session: createSession({id: 'bigtable-e2e', appName: 'bigtable-e2e'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe.skipIf(!projectId)('BigtableToolset against a live project', () => {
  const toolset = new BigtableToolset();

  afterAll(async () => {
    await toolset.close();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const tools = await toolset.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`No tool named ${name}`);
    }
    return tool.runAsync({args, toolContext: createToolContext()});
  }

  it('lists instances and runs a query against the first one', async () => {
    const listed = await callTool('bigtable_list_instances', {projectId});
    expect(listed).toMatchObject({status: 'SUCCESS'});

    const instances = (listed as {results: Array<{instance_id: string}>})
      .results;
    if (instances.length === 0) {
      return;
    }

    const queried = await callTool('bigtable_execute_sql', {
      projectId,
      instanceId: instances[0].instance_id,
      query: 'SELECT 1 AS one',
    });
    expect(queried).toMatchObject({status: 'SUCCESS'});
  });
});
