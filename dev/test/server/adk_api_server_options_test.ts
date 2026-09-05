/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {LOGO_CONFIG_ERROR_MESSAGE} from '../../src/server/runtime_config.js';
import {setHomeDir} from '../temp_home.js';
import {
  createStubAgentLoader,
  getJson,
  getStatus,
  postJson,
} from './api_server_test_helpers.js';

const APP_NAME = 'optionsApp';
const LOGO_IMAGE_URL = 'https://acme.example/logo.svg';

interface DevUiConfig {
  logo_text: string | null;
  logo_image_url: string | null;
}

describe('AdkApiServer configuration surface', () => {
  let webAssetsDir: string;
  let runtimeConfigPath: string;
  let restoreHomeDir: () => void;
  let previousDefaultAppName: string | undefined;
  let server: AdkApiServer | undefined;

  beforeEach(async () => {
    webAssetsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-options-'));
    runtimeConfigPath = path.join(
      webAssetsDir,
      'assets',
      'config',
      'runtime-config.json',
    );
    restoreHomeDir = setHomeDir(webAssetsDir);
    previousDefaultAppName = process.env.ADK_DEFAULT_APP_NAME;
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    restoreHomeDir();
    if (previousDefaultAppName === undefined) {
      delete process.env.ADK_DEFAULT_APP_NAME;
    } else {
      process.env.ADK_DEFAULT_APP_NAME = previousDefaultAppName;
    }
    await fs.rm(webAssetsDir, {recursive: true, force: true});
  });

  function createServer(
    options: Partial<ConstructorParameters<typeof AdkApiServer>[0]> = {},
  ): AdkApiServer {
    server = new AdkApiServer({
      agentLoader: createStubAgentLoader(APP_NAME),
      sessionService: new InMemorySessionService(),
      serveDebugUI: true,
      webAssetsDir,
      ...options,
    });
    return server;
  }

  describe('GET /dev-ui/config', () => {
    it('reports null for both keys when no logo is configured', async () => {
      const started = createServer();
      await started.start();

      const response = await getJson<DevUiConfig>(
        `${started.url}/dev-ui/config`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({logo_text: null, logo_image_url: null});
    });

    it('reports the configured logo', async () => {
      const started = createServer({
        logoText: 'Acme',
        logoImageUrl: LOGO_IMAGE_URL,
      });
      await started.start();

      const response = await getJson<DevUiConfig>(
        `${started.url}/dev-ui/config`,
      );

      expect(response.body).toEqual({
        logo_text: 'Acme',
        logo_image_url: LOGO_IMAGE_URL,
      });
    });

    it('answers ahead of the static mount, which holds a config file', async () => {
      // A file the static mount would serve at the same path if it won.
      await fs.mkdir(path.join(webAssetsDir, 'dev-ui'), {recursive: true});
      await fs.writeFile(
        path.join(webAssetsDir, 'config'),
        'from the file system',
        'utf-8',
      );
      const started = createServer({
        logoText: 'Acme',
        logoImageUrl: LOGO_IMAGE_URL,
      });
      await started.start();

      const response = await getJson<DevUiConfig>(
        `${started.url}/dev-ui/config`,
      );

      expect(response.body.logo_text).toBe('Acme');
    });

    it('is not registered when the dev UI is off', async () => {
      const started = createServer({serveDebugUI: false});
      await started.start();

      expect(await getStatus(`${started.url}/dev-ui/config`)).toBe(404);
    });
  });

  describe('runtime-config.json', () => {
    async function readRuntimeConfig(): Promise<Record<string, unknown>> {
      return JSON.parse(await fs.readFile(runtimeConfigPath, 'utf-8'));
    }

    it('is written at start-up in dev-UI mode', async () => {
      await createServer({urlPrefix: '/adk'}).start();

      expect(await readRuntimeConfig()).toEqual({
        backendUrl: '/adk',
        telemetry: null,
      });
    });

    it('carries the logo block when one is configured', async () => {
      await createServer({
        logoText: 'Acme',
        logoImageUrl: LOGO_IMAGE_URL,
      }).start();

      expect((await readRuntimeConfig())['logo']).toEqual({
        text: 'Acme',
        imageUrl: LOGO_IMAGE_URL,
      });
    });

    it('is not written when the dev UI is off', async () => {
      await createServer({serveDebugUI: false}).start();

      await expect(fs.access(runtimeConfigPath)).rejects.toThrow();
    });

    it('is skipped, without failing start-up, when the assets are missing', async () => {
      const missingDir = path.join(webAssetsDir, 'not-built');

      await expect(
        createServer({webAssetsDir: missingDir}).start(),
      ).resolves.toBeUndefined();
      await expect(fs.access(missingDir)).rejects.toThrow();
    });

    it('rejects start-up when only the logo text is set', async () => {
      await expect(createServer({logoText: 'Acme'}).start()).rejects.toThrow(
        LOGO_CONFIG_ERROR_MESSAGE,
      );
    });

    it('rejects start-up when only the logo image url is set', async () => {
      await expect(
        createServer({logoImageUrl: LOGO_IMAGE_URL}).start(),
      ).rejects.toThrow(LOGO_CONFIG_ERROR_MESSAGE);
    });

    it('rejects start-up on a half-set logo even without the web assets', async () => {
      await expect(
        createServer({
          logoText: 'Acme',
          webAssetsDir: path.join(webAssetsDir, 'not-built'),
        }).start(),
      ).rejects.toThrow(LOGO_CONFIG_ERROR_MESSAGE);
    });
  });

  describe('default app name', () => {
    it('does not let a traversal-shaped path reach another app', async () => {
      process.env.ADK_DEFAULT_APP_NAME = APP_NAME;
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'secret_app',
        userId: 'u1',
        sessionId: 's1',
      });
      const started = createServer({serveDebugUI: false, sessionService});
      await started.start();

      expect(
        await getStatus(
          `${started.url}/users/..%2F..%2Fapps%2Fsecret_app%2Fusers%2Fu1/sessions/s1`,
        ),
      ).toBe(404);
    });

    it('lets /run_sse omit appName', async () => {
      process.env.ADK_DEFAULT_APP_NAME = APP_NAME;
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: APP_NAME,
        userId: 'u1',
        sessionId: 's1',
      });
      const started = createServer({serveDebugUI: false, sessionService});
      await started.start();

      const response = await fetch(`${started.url}/run_sse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          userId: 'u1',
          sessionId: 's1',
          newMessage: {role: 'user', parts: [{text: 'Hi'}]},
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Hello');
    });

    it('answers 400 on /run_sse without appName and without a default', async () => {
      delete process.env.ADK_DEFAULT_APP_NAME;
      const started = createServer({serveDebugUI: false});
      await started.start();

      const response = await postJson<{error: string}>(
        `${started.url}/run_sse`,
        {
          userId: 'u1',
          sessionId: 's1',
          newMessage: {role: 'user', parts: [{text: 'Hi'}]},
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toBe(
        'app_name is required when ADK_DEFAULT_APP_NAME is not set',
      );
    });

    it('still honours an explicit appName while a default is set', async () => {
      process.env.ADK_DEFAULT_APP_NAME = 'some_other_app';
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: APP_NAME,
        userId: 'u1',
        sessionId: 's1',
      });
      const started = createServer({serveDebugUI: false, sessionService});
      await started.start();

      const response = await postJson<Event[]>(`${started.url}/run`, {
        appName: APP_NAME,
        userId: 'u1',
        sessionId: 's1',
        newMessage: {role: 'user', parts: [{text: 'Hi'}]},
      });

      expect(response.status).toBe(200);
    });
  });
});
