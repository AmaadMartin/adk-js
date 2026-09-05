/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`, `tests/unittests/cli/test_fast_api.py`, at
 * commit a3bd1115. Each `it(...)` keeps the Python test name verbatim so a
 * reviewer can find the case on both sides.
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Session,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {DEFAULT_APP_NAME_ENV_VAR} from '../../src/server/default_app_rewrite.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

/** Reports the plugins the runner attached, so a test can assert on them. */
class PluginReportingAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const pluginNames = context.pluginManager
      .listPlugins()
      .map((plugin) => plugin.name);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {parts: [{text: JSON.stringify(pluginNames)}], role: 'model'},
    });
  }
}

const REPORTING_AGENT = new PluginReportingAgent({
  name: 'reporting_agent',
  description: 'reports the plugins it runs under',
});

function loaderFor(appNames: string[]): AgentLoader {
  return {
    listAgents: () => Promise.resolve(appNames),
    loadAgent: () => Promise.resolve(REPORTING_AGENT),
    getAgentFile: () =>
      Promise.resolve({
        load: () => Promise.resolve(REPORTING_AGENT),
        async [Symbol.asyncDispose](): Promise<void> {
          return;
        },
      }),
  } as unknown as AgentLoader;
}

interface RunResponse {
  status: number;
  body: unknown;
}

async function post(
  baseUrl: string,
  url: string,
  body: unknown,
): Promise<RunResponse> {
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return {status: response.status, body: await response.json()};
}

/** Reads the body as JSON only when the server sent JSON, as a 404 does not. */
async function get(baseUrl: string, url: string): Promise<RunResponse> {
  const response = await fetch(`${baseUrl}${url}`, {redirect: 'manual'});
  const isJson = response.headers
    .get('content-type')
    ?.includes('application/json');
  return {
    status: response.status,
    body: isJson ? await response.json() : await response.text(),
  };
}

/** Reads the plugin names the reporting agent put in its single event. */
function pluginNamesFrom(body: unknown): string[] {
  const events = body as Array<{content?: {parts?: Array<{text?: string}>}}>;
  const text = events[0]?.content?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail(`No event text in ${JSON.stringify(body)}`);
  }
  return JSON.parse(text) as string[];
}

describe('api_server parity', () => {
  let agentsDir: string;
  let sessionService: InMemorySessionService;
  let servers: AdkApiServer[];

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-parity-agents-'));
    sessionService = new InMemorySessionService();
    servers = [];
    delete process.env[DEFAULT_APP_NAME_ENV_VAR];
  });

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    fs.rmSync(agentsDir, {recursive: true, force: true});
    delete process.env[DEFAULT_APP_NAME_ENV_VAR];
  });

  async function startServer(
    options: ConstructorParameters<typeof AdkApiServer>[0] = {},
  ): Promise<AdkApiServer> {
    const server = new AdkApiServer({
      agentsDir,
      agentLoader: loaderFor([APP_NAME]),
      sessionService,
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
      ...options,
    });
    servers.push(server);
    await server.start();
    return server;
  }

  function createSessionFor(appName: string): Promise<Session> {
    return sessionService.createSession({
      appName,
      userId: USER_ID,
      sessionId: SESSION_ID,
      state: {},
    });
  }

  function writePluginsYaml(appName: string, contents: string): void {
    fs.mkdirSync(path.join(agentsDir, appName), {recursive: true});
    fs.writeFileSync(path.join(agentsDir, appName, 'plugins.yaml'), contents);
  }

  function runPayload(appName?: string): Record<string, unknown> {
    return {
      ...(appName ? {appName} : {}),
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    };
  }

  it('test_agent_with_bigquery_analytics_plugin', async () => {
    writePluginsYaml(
      APP_NAME,
      [
        'bigquery_agent_analytics:',
        '  project_id: test-project',
        '  dataset_id: test-dataset',
        '  table_id: test-table',
        '  dataset_location: US',
      ].join('\n'),
    );
    const server = await startServer();
    await createSessionFor(APP_NAME);

    const response = await post(server.url, '/run', runPayload(APP_NAME));

    expect(response.status).toBe(200);
    expect(pluginNamesFrom(response.body)).toEqual([
      'bigquery_agent_analytics',
    ]);
  });

  it('attaches no analytics plugin when plugins.yaml is incomplete', async () => {
    writePluginsYaml(
      APP_NAME,
      ['bigquery_agent_analytics:', '  project_id: test-project'].join('\n'),
    );
    const server = await startServer();
    await createSessionFor(APP_NAME);

    const response = await post(server.url, '/run', runPayload(APP_NAME));

    expect(pluginNamesFrom(response.body)).toEqual([]);
  });

  it('test_default_app_name_middleware_and_resolution', async () => {
    process.env[DEFAULT_APP_NAME_ENV_VAR] = APP_NAME;
    const server = await startServer();
    await createSessionFor(APP_NAME);

    const session = await get(
      server.url,
      `/users/${USER_ID}/sessions/${SESSION_ID}`,
    );

    expect(session.status).toBe(200);
    expect((session.body as {id: string}).id).toBe(SESSION_ID);
  });

  it('test_default_app_name_not_set_raises_error', async () => {
    const server = await startServer();
    await createSessionFor(APP_NAME);

    const session = await get(
      server.url,
      `/users/${USER_ID}/sessions/${SESSION_ID}`,
    );

    expect(session.status).toBe(404);
  });

  it('serves the dev UI logo config when the logo is configured', async () => {
    const server = await startServer({
      serveDebugUI: true,
      webAssetsDir: path.join(agentsDir, 'browser'),
      logoText: 'Acme',
      logoImageUrl: 'https://acme.example/logo.png',
    });

    const response = await get(server.url, '/dev-ui/config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      logo_text: 'Acme',
      logo_image_url: 'https://acme.example/logo.png',
    });
  });

  it('reports both logo fields as null when no logo is configured', async () => {
    const server = await startServer({
      serveDebugUI: true,
      webAssetsDir: path.join(agentsDir, 'browser'),
    });

    const response = await get(server.url, '/dev-ui/config');

    expect(response.body).toEqual({logo_text: null, logo_image_url: null});
  });

  it('does not serve the dev UI logo config from the API server', async () => {
    const server = await startServer({serveDebugUI: false});

    const response = await fetch(`${server.url}/dev-ui/config`);

    expect(response.status).toBe(404);
  });

  it('rejects a logo with only one of its two values', () => {
    expect(() => new AdkApiServer({agentsDir, logoText: 'Acme'})).toThrow(
      'Both --logo-text and --logo-image-url must be defined',
    );
  });

  it('attaches the plugins named by extraPlugins', async () => {
    const pluginModule = path
      .join(__dirname, 'testdata', 'example_plugins.ts')
      .replace(/\\/g, '/');
    const server = await startServer({
      extraPlugins: [`${pluginModule}#examplePluginInstance`],
    });
    await createSessionFor(APP_NAME);

    const response = await post(server.url, '/run', runPayload(APP_NAME));

    expect(pluginNamesFrom(response.body)).toEqual(['configured-name']);
  });

  it('keeps serving when an extra plugin cannot be loaded', async () => {
    const server = await startServer({
      extraPlugins: ['@acme/no-such-package#AuditPlugin'],
    });
    await createSessionFor(APP_NAME);

    const response = await post(server.url, '/run', runPayload(APP_NAME));

    expect(response.status).toBe(200);
    expect(pluginNamesFrom(response.body)).toEqual([]);
  });

  describe('defaultLlmModel', () => {
    /** An agent with no model of its own falls back to the process default. */
    function modelOfAgentWithoutOne(): string {
      return new LlmAgent({name: 'probe_agent'}).canonicalModel.model;
    }

    beforeEach(() => {
      // Resolving a Gemini model name needs a key, and this test only reads
      // back the name the server installed.
      vi.stubEnv('GOOGLE_API_KEY', 'placeholder-api-key');
    });

    afterEach(() => {
      LlmAgent.setDefaultModel(undefined);
      vi.unstubAllEnvs();
    });

    it('serves an agent that sets no model of its own', async () => {
      const server = await startServer({defaultLlmModel: 'gemini-2.5-flash'});
      await createSessionFor(APP_NAME);

      await post(server.url, '/run', runPayload(APP_NAME));

      expect(modelOfAgentWithoutOne()).toBe('gemini-2.5-flash');
    });

    it('leaves the process default alone when the option is unset', async () => {
      const server = await startServer();
      await createSessionFor(APP_NAME);

      await post(server.url, '/run', runPayload(APP_NAME));

      expect(() => modelOfAgentWithoutOne()).toThrow('No model found');
    });
  });
});
