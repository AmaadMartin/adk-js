/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AdkApiServer} from '@google/adk-devtools';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'agent';
const LOGO_IMAGE_URL = 'https://acme.example/logo.svg';

/**
 * Drives a real server loaded from an agents directory on disk, with a
 * default app name and a temporary web assets directory. No model is called.
 */
describe('API server configuration surface', () => {
  let server: AdkApiServer;
  let webAssetsDir: string;
  let url: string;
  let previousDefaultAppName: string | undefined;

  beforeAll(async () => {
    webAssetsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-assets-'));
    previousDefaultAppName = process.env.ADK_DEFAULT_APP_NAME;
    process.env.ADK_DEFAULT_APP_NAME = APP_NAME;

    server = new AdkApiServer({
      agentsDir: path.resolve(__dirname, '../adk_web/agent'),
      port: 0,
      serveDebugUI: true,
      webAssetsDir,
      urlPrefix: '/adk',
      logoText: 'Acme',
      logoImageUrl: LOGO_IMAGE_URL,
    });
    await server.start();
    url = server.url;
  }, 30000);

  afterAll(async () => {
    await server?.stop();
    if (previousDefaultAppName === undefined) {
      delete process.env.ADK_DEFAULT_APP_NAME;
    } else {
      process.env.ADK_DEFAULT_APP_NAME = previousDefaultAppName;
    }
    await fs.rm(webAssetsDir, {recursive: true, force: true});
  });

  it('resolves an unqualified session path against the default app', async () => {
    const created = await fetch(`${url}/users/u1/sessions/s1`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(200);

    const read = await fetch(`${url}/users/u1/sessions/s1`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as {id: string}).id).toBe('s1');
  });

  it('writes runtime-config.json with the backend url and the logo', async () => {
    const contents = await fs.readFile(
      path.join(webAssetsDir, 'assets', 'config', 'runtime-config.json'),
      'utf-8',
    );

    expect(JSON.parse(contents)).toMatchObject({
      backendUrl: '/adk',
      logo: {text: 'Acme', imageUrl: LOGO_IMAGE_URL},
    });
  });

  it('serves the configured logo from /dev-ui/config', async () => {
    const response = await fetch(`${url}/dev-ui/config`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      logo_text: 'Acme',
      logo_image_url: LOGO_IMAGE_URL,
    });
  });
});
