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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
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

/** Options each construction of the analytics plugin was given. */
const constructedWith = vi.hoisted(() => [] as unknown[]);

/** Invocations the analytics plugin's beforeRun callback observed. */
const observedInvocations = vi.hoisted(() => [] as string[]);

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  class FakeBigQueryAgentAnalyticsPlugin extends actual.BasePlugin {
    constructor(options: unknown) {
      super('bigquery_agent_analytics');
      constructedWith.push(options);
    }

    override async beforeRunCallback(params: {
      invocationContext: {invocationId: string};
    }): Promise<undefined> {
      observedInvocations.push(params.invocationContext.invocationId);
      return undefined;
    }
  }
  return {
    ...actual,
    BigQueryAgentAnalyticsPlugin: FakeBigQueryAgentAnalyticsPlugin,
  };
});

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
  const originalCwd = process.cwd();
  let agentsDir: string;
  let sessionService: InMemorySessionService;
  let server: AdkApiServer;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-parity-'));
    await fs.mkdir(path.join(agentsDir, APP_NAME));
    sessionService = new InMemorySessionService();
    constructedWith.length = 0;
    observedInvocations.length = 0;
  });

  afterEach(async () => {
    await server.stop();
    process.chdir(originalCwd);
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
    server = new AdkApiServer({
      agentsDir,
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
    expect(constructedWith).toEqual([
      {
        projectId: 'test-project',
        datasetId: 'test-dataset',
        tableId: 'test-table',
        location: 'US',
      },
    ]);
    expect(observedInvocations).toHaveLength(1);
  });

  it('attaches no plugin when the app has no plugins.yaml', async () => {
    server = new AdkApiServer({
      agentsDir,
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
    expect(constructedWith).toEqual([]);
  });

  // Without an agentsDir there is no directory the app came from, so the
  // server must not fall back to the working directory and read whatever
  // plugins.yaml happens to sit there.
  it('does not read a plugins.yaml under the working directory', async () => {
    await fs.writeFile(
      path.join(agentsDir, APP_NAME, 'plugins.yaml'),
      PLUGINS_YAML_CONTENT,
    );
    process.chdir(agentsDir);
    server = new AdkApiServer({
      agentLoader: new StubAgentLoader(APP_NAME),
      sessionService,
    });
    await server.start();

    const response = await runOnce();

    expect(response.status).toBe(200);
    expect(constructedWith).toEqual([]);
  });
});
