/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AdkApiServer} from '@google/adk-devtools';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer as AdkCliApiServer} from '../test_api_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Budget (ms) for `beforeAll`: the CLI case boots the server as a child
 * process.
 */
const SERVER_START_TIMEOUT = 20000;

/**
 * Budget (ms) for `afterAll`: `stop()` is `http.Server.close()`, which settles
 * only once every open connection has drained. Stated explicitly so a socket
 * that never closes fails fast here, rather than on whatever hook budget the
 * `integration` project supplies.
 */
const SERVER_STOP_TIMEOUT = 10000;

/**
 * Built artifacts this suite serves over HTTP: the CLI entrypoint spawned by
 * `AdkTsApiServer`, and the adk-web bundle `AdkApiServer` mounts at `/dev-ui`.
 * `dist/browser` is a downloaded release asset rather than a compile output,
 * so it can be missing from an otherwise-built tree.
 */
const REQUIRED_BUILD_ARTIFACTS = [
  path.resolve(__dirname, '../../../dev/dist/esm/cli_entrypoint.js'),
  path.resolve(__dirname, '../../../dev/dist/browser/index.html'),
];

function assertRepoIsBuilt(): void {
  const missing = REQUIRED_BUILD_ARTIFACTS.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      'webui_test.ts exercises built output; run `npm run build` first. ' +
        `Missing: ${missing.join(', ')}`,
    );
  }
}

describe('WebUI Integration Test', () => {
  beforeAll(assertRepoIsBuilt);

  describe.each([
    {
      name: 'Run from ADK CLI',
      serverClass: AdkCliApiServer,
    },
    {
      name: 'Using ADK API server',
      serverClass: AdkApiServer,
    },
  ])(
    '$name',
    ({
      serverClass,
    }: {
      serverClass: typeof AdkApiServer | typeof AdkCliApiServer;
    }) => {
      let server: AdkApiServer | AdkCliApiServer;
      let url: string;

      beforeAll(async () => {
        server = new serverClass({
          agentsDir: path.resolve(__dirname, './agent'),
          port: 0,
          serveDebugUI: true,
        });
        await server.start();
        url = server.url;
      }, SERVER_START_TIMEOUT);

      afterAll(async () => {
        if (server) {
          await server.stop();
        }
      }, SERVER_STOP_TIMEOUT);

      it('should load the WebUI correctly while running the agent from adk CLI', async () => {
        return new Promise<void>((resolve, reject) => {
          http
            .get(`${url}/dev-ui/`, (res) => {
              try {
                expect(res.statusCode).toBe(200);

                let data = '';
                res.on('data', (chunk) => {
                  data += chunk;
                });

                res.on('end', () => {
                  try {
                    // Verify that the response contains typical HTML markers for the WebUI
                    expect(data).toContain('<app-root>');
                    resolve();
                  } catch (e) {
                    reject(e);
                  }
                });
              } catch (e) {
                reject(e);
              }
            })
            .on('error', (err) => {
              reject(err);
            });
        });
      });
    },
  );
}, 20000);
