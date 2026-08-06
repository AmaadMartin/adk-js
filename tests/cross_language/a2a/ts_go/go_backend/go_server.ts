/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import {BaseTestServer} from '../../../../integration/test_case_utils.js';
import {ensureGoModules} from '../../../go_modules.js';

/**
 * Interface representing the parameters for creating the test Go agent server.
 */
export interface TestGoServerParams {
  serverDir: string;
  port?: number;
  startFailureTimeout?: number;
}

/**
 * Readiness budget (ms). Matches `AdkTsApiServer`'s 60000 because `go run .`
 * compiles the module before the server boots.
 */
const DEFAULT_TIMEOUT = 60000;

/**
 * Go server for testing.
 */
export class AdkGoServer extends BaseTestServer {
  private params: TestGoServerParams;

  constructor(params: TestGoServerParams) {
    super('127.0.0.1', params.port);
    this.params = params;
  }

  async start(): Promise<void> {
    await ensureGoModules(this.params.serverDir);

    await this.startProcess({
      spawnProcess: () => {
        return spawn('go', ['run', '.'], {
          cwd: this.params.serverDir,
          env: {
            ...process.env,
            PORT: this.port.toString(),
          },
        });
      },
      startMessage: 'A2A Server started on',
      successLogMessage: `Test Go Server started at ${this.url}`,
      serverName: 'Go Server',
      timeoutMs: this.params.startFailureTimeout || DEFAULT_TIMEOUT,
    });
  }
}
