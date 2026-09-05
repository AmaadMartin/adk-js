/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from `google/adk-python` at `main`:
 * `src/google/adk/cli/api_server.py` and
 * `tests/unittests/cli/test_fast_api.py`. Test names are kept verbatim so the
 * two suites can be compared by name.
 */

import {
  BasePlugin,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  RunnableRoot,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {BigQueryAnalyticsPluginOptions} from '../../src/server/plugins_config.js';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

const APP_NAME = 'bq_app';

const PLUGINS_YAML_CONTENT = `bigquery_agent_analytics:
  project_id: test-project
  dataset_id: test-dataset
  table_id: test-table
  dataset_location: US
`;

class SilentAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'done'}], role: 'model'},
    });
  }
}

/** Stands in for the BigQuery plugin and records that the runner ran it. */
class SpyAnalyticsPlugin extends BasePlugin {
  readonly invocationIds: string[] = [];

  constructor(readonly options: BigQueryAnalyticsPluginOptions) {
    super('bigquery_agent_analytics');
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    this.invocationIds.push(params.invocationContext.invocationId);
    return undefined;
  }
}

/** Serves one in-memory agent, so no agent file has to be compiled. */
class StubAgentFile extends AgentFile {
  constructor(private readonly root: RunnableRoot) {
    super('<in-memory>');
  }

  override load(): Promise<RunnableRoot> {
    return Promise.resolve(this.root);
  }
}

class StubAgentLoader extends AgentLoader {
  private readonly file = new StubAgentFile(
    new SilentAgent({name: 'silentAgent'}),
  );

  constructor(private readonly appName: string) {
    super();
  }

  override listAgents(): Promise<string[]> {
    return Promise.resolve([this.appName]);
  }

  override getAgentFile(): Promise<AgentFile> {
    return Promise.resolve(this.file);
  }
}

describe('api_server plugins.yaml parity', () => {
  let agentsDir: string;
  let sessionService: InMemorySessionService;
  let server: AdkApiServer;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-parity-'));
    await fs.mkdir(path.join(agentsDir, APP_NAME));
    sessionService = new InMemorySessionService();
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  async function runOnce(): Promise<Response> {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: 'test_user',
      sessionId: 'test_session',
    });
    return fetch(`${server.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        appName: APP_NAME,
        userId: 'test_user',
        sessionId: 'test_session',
        newMessage: {parts: [{text: 'hello'}], role: 'user'},
      }),
    });
  }

  it('test_agent_with_bigquery_analytics_plugin', async () => {
    await fs.writeFile(
      path.join(agentsDir, APP_NAME, 'plugins.yaml'),
      PLUGINS_YAML_CONTENT,
    );
    const built: SpyAnalyticsPlugin[] = [];
    server = new AdkApiServer({
      agentsDir,
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
      bigQueryAnalyticsPluginFactory: async (options) => {
        const plugin = new SpyAnalyticsPlugin(options);
        built.push(plugin);
        return plugin;
      },
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
    expect(built).toHaveLength(1);
    expect(built[0].options).toEqual({
      projectId: 'test-project',
      datasetId: 'test-dataset',
      tableId: 'test-table',
      location: 'US',
    });
    expect(built[0].invocationIds).toHaveLength(1);
  });

  it('attaches no plugin when the app has no plugins.yaml', async () => {
    let called = false;
    server = new AdkApiServer({
      agentsDir,
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
      bigQueryAnalyticsPluginFactory: async () => {
        called = true;
        return undefined;
      },
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
    expect(called).toBe(false);
  });

  it('starts and serves the app when the factory builds no plugin', async () => {
    await fs.writeFile(
      path.join(agentsDir, APP_NAME, 'plugins.yaml'),
      PLUGINS_YAML_CONTENT,
    );
    server = new AdkApiServer({
      agentsDir,
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
      bigQueryAnalyticsPluginFactory: async () => undefined,
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
  });
});
