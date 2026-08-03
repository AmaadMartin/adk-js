/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AdkApiServer} from '@google/adk-devtools';
import * as http from 'node:http';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer as AdkCliApiServer} from '../test_api_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('WebUI Integration Test', () => {
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

      // No local timeout: the hook inherits the `integration` project's
      // hookTimeout from vitest.config.ts, which must stay above
      // AdkTsApiServer's own 60s start watchdog (test_api_server.ts) so the
      // server's captured-stdout diagnostic surfaces instead of a bare hook
      // timeout.
      beforeAll(async () => {
        server = new serverClass({
          agentsDir: path.resolve(__dirname, './agent'),
          port: 0,
          serveDebugUI: true,
        });
        await server.start();
        url = server.url;
      });

      afterAll(async () => {
        if (server) {
          await server.stop();
        }
      });

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
});
