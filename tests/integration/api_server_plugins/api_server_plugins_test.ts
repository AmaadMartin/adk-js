/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, InvocationContext} from '@google/adk';
import {AdkApiServer} from '@google/adk-devtools';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'bq_app';
const USER_ID = 'integration_user';
const SESSION_ID = 'integration_session';

interface AnalyticsPluginOptions {
  projectId: string;
  datasetId: string;
  tableId?: string;
  location: string;
}

/**
 * Stands in for `BigQueryAgentAnalyticsPlugin`, which `@google/adk` does not
 * export on this branch. Everything else here is real: a real agent directory,
 * a real `plugins.yaml`, a real listener and real HTTP requests.
 */
class AnalyticsProbePlugin extends BasePlugin {
  readonly invocationIds: string[] = [];

  constructor(readonly options: AnalyticsPluginOptions) {
    super('bigquery_agent_analytics');
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    this.invocationIds.push(params.invocationContext.invocationId);
    return undefined;
  }
}

describe('API server plugins.yaml', () => {
  const built: AnalyticsProbePlugin[] = [];
  let server: AdkApiServer;
  let url: string;

  beforeAll(async () => {
    server = new AdkApiServer({
      agentsDir: path.resolve(__dirname),
      port: 0,
      bigQueryAnalyticsPluginFactory: async (options) => {
        const plugin = new AnalyticsProbePlugin(options);
        built.push(plugin);
        return plugin;
      },
    });
    await server.start();
    url = server.url;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('attaches the plugin an app declares on disk to its runner', async () => {
    const created = await fetch(
      `${url}/apps/${APP_NAME}/users/${USER_ID}/sessions/${SESSION_ID}`,
      {method: 'POST', headers: {'Content-Type': 'application/json'}},
    );
    expect(created.status).toBe(200);

    const run = await fetch(`${url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {parts: [{text: 'hello'}], role: 'user'},
      }),
    });

    expect(run.status).toBe(200);
    expect(built).toHaveLength(1);
    expect(built[0].options).toEqual({
      projectId: 'fixture-project',
      datasetId: 'fixture_dataset',
      tableId: 'fixture_events',
      location: 'US',
    });
    expect(built[0].invocationIds).toHaveLength(1);
  });
});
