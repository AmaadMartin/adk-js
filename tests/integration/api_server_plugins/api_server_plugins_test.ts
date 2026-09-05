/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `plugins.yaml` with no mocks at all: a real agent directory, a real
 * `plugins.yaml`, the real `AgentLoader`, a real listener and real HTTP.
 *
 * `@google/adk` does not export `BigQueryAgentAnalyticsPlugin` on this branch,
 * so the honest end-to-end outcome is the documented degradation — the server
 * reads the file, reaches the import, names the export it wanted, and serves
 * the app anyway. Construction of the plugin itself is covered by
 * `dev/test/server/plugins_config_bigquery_export_test.ts`.
 */

import {Logger, LogLevel} from '@google/adk';
import {AdkApiServer} from '@google/adk-devtools';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'bq_app';
const USER_ID = 'integration_user';
const SESSION_ID = 'integration_session';

class CapturingLogger implements Logger {
  readonly warnMessages: string[] = [];

  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(...args: unknown[]): void {
    this.warnMessages.push(args.join(' '));
  }
  error(..._args: unknown[]): void {}
  setLogLevel(_level: LogLevel): void {}
}

describe('API server plugins.yaml', () => {
  const logger = new CapturingLogger();
  let server: AdkApiServer;
  let url: string;

  beforeAll(async () => {
    server = new AdkApiServer({
      agentsDir: path.resolve(__dirname),
      port: 0,
      logger,
    });
    await server.start();
    url = server.url;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('reads the plugins.yaml an app declares on disk and still serves it', async () => {
    const created = await fetch(
      `${url}/apps/${APP_NAME}/users/${USER_ID}/sessions/${SESSION_ID}`,
      {method: 'POST', headers: {'Content-Type': 'application/json'}},
    );
    expect(created.status).toBe(200);

    const run = await fetch(`${url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {parts: [{text: 'hello'}], role: 'user'},
      }),
    });

    expect(run.status).toBe(200);
    // The block on disk is complete, so the loader got past both guards and
    // reached the import. An absent or incomplete file logs nothing here.
    expect(logger.warnMessages).toEqual([
      'Not attaching the BigQuery agent analytics plugin: the installed ' +
        '@google/adk does not export BigQueryAgentAnalyticsPlugin.',
    ]);
  });
});
