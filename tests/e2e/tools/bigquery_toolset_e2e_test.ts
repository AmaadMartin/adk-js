/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {BigQueryToolset, ExecuteSqlSuccess} from '@google/adk-integrations';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, it} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** A public table that every project can read. */
const PUBLIC_TABLE = '`bigquery-public-data.samples.shakespeare`';

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'bigquery-e2e',
      agent: new LlmAgent({name: 'bigquery_e2e_agent'}),
      session: createSession({
        id: 'bigquery-e2e-session',
        appName: 'bigquery-e2e',
        userId: 'bigquery-e2e-user',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('E2E Live BigQueryToolset', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  // Live E2E runs bill the query to a real project and need BigQuery access,
  // so they require an explicit opt-in variable rather than the ambient
  // GOOGLE_CLOUD_PROJECT, which is often set without BigQuery permissions.
  const liveProjectId = process.env.GCP_LIVE_BIGQUERY_PROJECT;
  const hasLiveCredentials = !!liveProjectId;

  it('exposes the expected tools without contacting the API', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'execute_sql',
      'get_dataset_info',
      'get_job_info',
      'get_table_info',
      'list_dataset_ids',
      'list_table_ids',
    ]);
    await toolset.close();
  });

  it.skipIf(!hasLiveCredentials)(
    'runs a real query against a public dataset',
    async () => {
      // The query reads a public table but is billed to the caller's own
      // project, which is what `project_id` selects.
      const projectId = liveProjectId!;

      const toolset = new BigQueryToolset(['execute_sql']);
      const [executeSqlTool] = await toolset.getTools();
      expect(executeSqlTool.name).toBe('execute_sql');

      const result = await executeSqlTool.runAsync({
        args: {
          project_id: projectId,
          query: `SELECT corpus, word_count FROM ${PUBLIC_TABLE} LIMIT 3`,
        },
        toolContext: createToolContext(),
      });

      expect(result).toMatchObject({status: 'SUCCESS'});
      const {rows} = result as ExecuteSqlSuccess;
      expect(rows).toHaveLength(3);
      for (const row of rows ?? []) {
        expect(typeof row['corpus']).toBe('string');
        expect(typeof row['word_count']).toBe('number');
      }

      await toolset.close();
    },
    60_000,
  );

  it.skipIf(!hasLiveCredentials)(
    'rejects a write in the default BLOCKED mode',
    async () => {
      const projectId = liveProjectId!;

      const toolset = new BigQueryToolset(['execute_sql']);
      const [executeSqlTool] = await toolset.getTools();

      const result = await executeSqlTool.runAsync({
        args: {
          project_id: projectId,
          query: `CREATE TABLE ${projectId}.adk_e2e.should_not_exist (x INT64)`,
        },
        toolContext: createToolContext(),
      });

      // Asserting the specific message matters: a plain `status: 'ERROR'`
      // would also pass if the call had merely failed to authenticate.
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Read-only mode only supports SELECT statements.',
      });

      await toolset.close();
    },
    60_000,
  );
});
