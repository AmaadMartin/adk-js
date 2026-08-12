/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigtableToolset,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
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

/** Narrows a tool result to a record so its fields can be asserted. */
function asRecord(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) {
    expect.fail(`Expected a tool result object but got ${String(result)}`);
  }
  return result as Record<string, unknown>;
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
      expect.fail(`No tool named ${name}`);
    }
    return asRecord(
      await tool.runAsync({args, toolContext: createToolContext()}),
    );
  }

  it('lists instances and runs a query against the first one', async () => {
    const listed = await callTool('bigtable_list_instances', {projectId});
    expect(listed['status']).toBe('SUCCESS');

    const instances = listed['results'];
    if (!Array.isArray(instances) || instances.length === 0) {
      return;
    }
    const instanceId = asRecord(instances[0])['instance_id'];
    expect(instanceId).toEqual(expect.any(String));

    const tables = await callTool('bigtable_list_tables', {
      projectId,
      instanceId,
    });
    expect(tables['status']).toBe('SUCCESS');

    const queried = await callTool('bigtable_execute_sql', {
      projectId,
      instanceId,
      query: 'SELECT 1 AS one',
    });
    expect(queried['status']).toBe('SUCCESS');
    // The rows sit at the top level of the payload, as in adk-python, and the
    // truncation key is absent when the row cap was not reached.
    expect(Array.isArray(queried['rows'])).toBe(true);
    expect(queried).not.toHaveProperty('result_is_likely_truncated');
  });

  it('reports an unknown instance as an error instead of throwing', async () => {
    const result = await callTool('bigtable_get_instance_info', {
      projectId,
      instanceId: 'no-such-instance-e2e',
    });

    expect(result['status']).toBe('ERROR');
    expect(result['error_details']).toEqual(expect.any(String));
  });
});
