/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {AdkApiClient} from '../../dev/src/server/adk_api_client.js';
import {BaseTestServer} from './test_case_utils.js';

/**
 * Interface representing the parameters for creating the test ADK API server.
 */
export interface TestApiServerParams {
  agentsDir: string;
  port?: number;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  a2a?: boolean;
  startFailureTimeout?: number;
  serveDebugUI?: boolean;
}

const DEFAULT_TIMEOUT = 60000;

/** The built ADK CLI entrypoint that the test server spawns. */
const CLI_ENTRYPOINT_PATH = path.resolve(
  __dirname,
  '../../dev/dist/esm/cli_entrypoint.js',
);

/**
 * Throws if the ADK CLI has not been built.
 *
 * The integration tests spawn the compiled CLI. On an unbuilt checkout the
 * child exits 1 with `ERR_MODULE_NOT_FOUND` and the harness reports only
 * `CLI exited prematurely with code 1`. This check verifies the entrypoint
 * alone, not that every workspace is built.
 */
export function assertAdkCliBuilt(cliPath: string): void {
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `ADK CLI entrypoint not found at ${cliPath}. ` +
        'The integration tests spawn the built CLI; run `npm run build` from ' +
        'the repository root first.',
    );
  }
}

/**
 * ADK API server for testing via the CLI. This is useful for integration tests
 * that require an ADK API server to be running.
 */
export class AdkTsApiServer extends BaseTestServer {
  private params: TestApiServerParams;

  constructor(params: TestApiServerParams) {
    super('localhost', params.port || 0);
    this.params = params;
  }

  async start(): Promise<AdkApiClient> {
    assertAdkCliBuilt(CLI_ENTRYPOINT_PATH);

    await this.startProcess({
      spawnProcess: () => {
        return spawn('node', this.getAdkCliArgs(this.params), {
          env: {
            ...process.env,
            TEST_API_SERVER_PORT: this.port.toString(),
          },
        });
      },
      startMessage: 'ADK API Server started',
      successLogMessage: `Test ADK API Server started`,
      serverName: 'CLI',
      timeoutMs: this.params.startFailureTimeout || DEFAULT_TIMEOUT,
    });

    return new AdkApiClient({backendUrl: this.url});
  }

  private getAdkCliArgs(params: TestApiServerParams): string[] {
    const args = [
      CLI_ENTRYPOINT_PATH,
      params.serveDebugUI ? 'web' : 'api_server',
      params.agentsDir,
      '--port',
      this.port.toString(),
      '--allow_origins',
      '*',
    ];

    if (params.sessionServiceUri) {
      args.push('--session_service_uri', params.sessionServiceUri);
    }
    if (params.artifactServiceUri) {
      args.push('--artifact_service_uri', params.artifactServiceUri);
    }
    if (params.a2a) {
      args.push('--a2a');
    }

    return args;
  }
}
