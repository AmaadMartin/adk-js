/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  AdkApiServer,
  MISSING_APP_NAME_ERROR,
} from '../../src/server/adk_api_server.js';
import {DEFAULT_APP_NAME_ENV_VAR} from '../../src/server/default_app_rewrite.js';
import {LOGO_CONFIG_ERROR_MESSAGE} from '../../src/server/runtime_config.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {CapturingLogger} from '../capturing_logger.js';

const APP_NAME = 'testApp';
const USER_ID = 'u1';
const SESSION_ID = 's1';
const TESTDATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testdata',
);
const LOGO_TEXT = 'Acme Agents';
const LOGO_IMAGE_URL = 'https://example.com/acme.svg';

class SilentAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'from the agent'}], role: 'model'},
    });
  }
}

function agentLoaderFor(...appNames: string[]): AgentLoader {
  const agent = new SilentAgent({name: 'silent'});

  return {
    listAgents: () => Promise.resolve(appNames),
    getAgentFile: () =>
      Promise.resolve({
        load: () => Promise.resolve(agent),
        async [Symbol.asyncDispose](): Promise<void> {
          return;
        },
      }),
  } as unknown as AgentLoader;
}

/** Text of the first part of the first event a `/run` response carries. */
function firstEventText(events: Event[]): string | undefined {
  return events[0]?.content?.parts?.[0]?.text;
}

describe('AdkApiServer configuration options', () => {
  let sessionService: BaseSessionService;
  let server: AdkApiServer | undefined;
  let logger: CapturingLogger;
  let webAssetsDir: string;
  let home: string;
  let originalHome: string | undefined;
  let originalDefaultApp: string | undefined;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    logger = new CapturingLogger();
    webAssetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-options-ui-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-options-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    originalDefaultApp = process.env[DEFAULT_APP_NAME_ENV_VAR];
    delete process.env[DEFAULT_APP_NAME_ENV_VAR];
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (originalDefaultApp === undefined) {
      delete process.env[DEFAULT_APP_NAME_ENV_VAR];
    } else {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = originalDefaultApp;
    }
    fs.rmSync(webAssetsDir, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  });

  function build(options: {
    extraPlugins?: string[];
    agentsDir?: string;
    serveDebugUI?: boolean;
    logoText?: string;
    logoImageUrl?: string;
  }): AdkApiServer {
    server = new AdkApiServer({
      agentLoader: agentLoaderFor(APP_NAME),
      sessionService,
      logger,
      webAssetsDir,
      ...options,
    });

    return server;
  }

  async function startWithSession(options: {
    extraPlugins?: string[];
    agentsDir?: string;
  }): Promise<AdkApiServer> {
    const started = build(options);
    await started.start();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      state: {},
    });

    return started;
  }

  async function run(
    started: AdkApiServer,
    body: Record<string, unknown>,
  ): Promise<{status: number; json: unknown}> {
    const response = await fetch(`${started.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });

    return {status: response.status, json: await response.json()};
  }

  const RUN_BODY = {
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text: 'hi'}]},
  };

  describe('extraPlugins', () => {
    it('attaches a loaded plugin to the runner', async () => {
      const started = await startWithSession({
        extraPlugins: ['./example_plugins.ts#namedInstance'],
        agentsDir: TESTDATA_DIR,
      });

      const {status, json} = await run(started, RUN_BODY);

      expect(status).toBe(200);
      expect(firstEventText(json as Event[])).toBe(
        'handled by preBuiltInstance',
      );
    });

    it('names a class plugin after its own specifier', async () => {
      const spec = './example_plugins.ts#NamePlugin';
      const started = await startWithSession({
        extraPlugins: [spec],
        agentsDir: TESTDATA_DIR,
      });

      const {json} = await run(started, RUN_BODY);

      expect(firstEventText(json as Event[])).toBe(`handled by ${spec}`);
    });

    it('runs the agent untouched when no plugin is configured', async () => {
      const started = await startWithSession({});

      const {json} = await run(started, RUN_BODY);

      expect(firstEventText(json as Event[])).toBe('from the agent');
    });

    it('serves the request when a plugin fails to load', async () => {
      const started = await startWithSession({
        extraPlugins: ['./missing_module.ts#Nope'],
        agentsDir: TESTDATA_DIR,
      });

      const {status, json} = await run(started, RUN_BODY);

      expect(status).toBe(200);
      expect(firstEventText(json as Event[])).toBe('from the agent');
      expect(logger.errorMessages[0]).toContain(
        'Failed to load plugin ./missing_module.ts#Nope',
      );
    });

    it('builds one plugin instance and shares it across apps', async () => {
      const secondApp = 'secondApp';
      server = new AdkApiServer({
        agentLoader: agentLoaderFor(APP_NAME, secondApp),
        sessionService,
        logger,
        webAssetsDir,
        extraPlugins: ['./example_plugins.ts#CountingPlugin'],
        agentsDir: TESTDATA_DIR,
      });
      await server.start();
      for (const appName of [APP_NAME, secondApp]) {
        await sessionService.createSession({
          appName,
          userId: USER_ID,
          sessionId: SESSION_ID,
          state: {},
        });
      }

      const first = await run(server, RUN_BODY);
      const second = await run(server, {...RUN_BODY, appName: secondApp});

      // Each app gets its own Runner. A per-app plugin instance would restart
      // the count, so the second app seeing "run 2" is what proves one shared
      // instance serves both.
      expect(firstEventText(first.json as Event[])).toBe('run 1');
      expect(firstEventText(second.json as Event[])).toBe('run 2');
    });
  });

  describe('default app name', () => {
    it('serves an app-name-less run when the environment names an app', async () => {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = APP_NAME;
      const started = await startWithSession({});

      const {status, json} = await run(started, {
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
      });

      expect(status).toBe(200);
      expect(firstEventText(json as Event[])).toBe('from the agent');
    });

    it('rejects an app-name-less run_sse when no app is named', async () => {
      const started = await startWithSession({});

      const response = await fetch(`${started.url}/run_sse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          userId: USER_ID,
          sessionId: SESSION_ID,
          newMessage: {role: 'user', parts: [{text: 'hi'}]},
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({error: MISSING_APP_NAME_ERROR});
    });

    it('serves an app-name-less run_sse when the environment names an app', async () => {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = APP_NAME;
      const started = await startWithSession({});

      const response = await fetch(`${started.url}/run_sse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          userId: USER_ID,
          sessionId: SESSION_ID,
          newMessage: {role: 'user', parts: [{text: 'hi'}]},
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('from the agent');
    });

    it('routes a rewritten path that carries a query string', async () => {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = APP_NAME;
      const started = await startWithSession({});

      const response = await fetch(
        `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}?ignored=1`,
      );

      expect(response.status).toBe(200);
      expect((await response.json()) as {id: string}).toMatchObject({
        id: SESSION_ID,
      });
    });

    it('prefers an app name the body supplies over the default', async () => {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = 'someOtherApp';
      const started = await startWithSession({});

      const {status, json} = await run(started, RUN_BODY);

      expect(status).toBe(200);
      expect(firstEventText(json as Event[])).toBe('from the agent');
    });
  });

  describe('dev UI configuration', () => {
    function runtimeConfigPath(): string {
      return path.join(webAssetsDir, 'assets', 'config', 'runtime-config.json');
    }

    it('writes the runtime config when the dev UI is served', async () => {
      const started = build({serveDebugUI: true});
      await started.start();

      expect(JSON.parse(fs.readFileSync(runtimeConfigPath(), 'utf-8'))).toEqual(
        {backendUrl: '', telemetry: null},
      );
    });

    it('writes no runtime config when the dev UI is off', async () => {
      const started = build({serveDebugUI: false});
      await started.start();

      expect(fs.existsSync(runtimeConfigPath())).toBe(false);
    });

    it('reports both logo fields as null when neither is configured', async () => {
      const started = build({serveDebugUI: true});
      await started.start();

      const response = await fetch(`${started.url}/dev-ui/config`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        logo_text: null,
        logo_image_url: null,
      });
    });

    it('reports the configured logo', async () => {
      const started = build({
        serveDebugUI: true,
        logoText: LOGO_TEXT,
        logoImageUrl: LOGO_IMAGE_URL,
      });
      await started.start();

      const response = await fetch(`${started.url}/dev-ui/config`);

      expect(await response.json()).toEqual({
        logo_text: LOGO_TEXT,
        logo_image_url: LOGO_IMAGE_URL,
      });
    });

    it('answers /dev-ui/config rather than the static asset of that name', async () => {
      fs.writeFileSync(
        path.join(webAssetsDir, 'config'),
        'static asset content',
      );
      const started = build({
        serveDebugUI: true,
        logoText: LOGO_TEXT,
        logoImageUrl: LOGO_IMAGE_URL,
      });
      await started.start();

      const response = await fetch(`${started.url}/dev-ui/config`);

      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({
        logo_text: LOGO_TEXT,
        logo_image_url: LOGO_IMAGE_URL,
      });
    });

    it('refuses to start with only a logo text', async () => {
      const started = build({serveDebugUI: true, logoText: LOGO_TEXT});

      await expect(started.start()).rejects.toThrowError(
        LOGO_CONFIG_ERROR_MESSAGE,
      );
      server = undefined;
    });

    it('refuses to start with only a logo image URL', async () => {
      const started = build({
        serveDebugUI: true,
        logoImageUrl: LOGO_IMAGE_URL,
      });

      await expect(started.start()).rejects.toThrowError(
        LOGO_CONFIG_ERROR_MESSAGE,
      );
      server = undefined;
    });

    it('starts anyway when the runtime config cannot be written', async () => {
      fs.writeFileSync(path.join(webAssetsDir, 'assets'), 'not a directory');
      const started = build({serveDebugUI: true});

      await started.start();

      expect(await (await fetch(`${started.url}/version`)).status).toBe(200);
      expect(logger.errorMessages[0]).toContain(
        'Failed to write runtime config file',
      );
    });
  });
});
