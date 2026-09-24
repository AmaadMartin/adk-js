/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python `tests/unittests/cli/test_fast_api.py` (`main`,
 * current), which cover the default app name. The `it(...)` names are the
 * Python test names, verbatim.
 *
 * `test_run_live_websocket_default_app_name` is not ported: adk-js serves no
 * `/run_live` websocket endpoint, so there is nothing to exercise.
 */

import {Event, InMemorySessionService, Session} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  createStubAgentLoader,
  getJson,
  getStatus,
  postJson,
} from './api_server_test_helpers.js';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

describe('default app name (ported from adk-python test_fast_api.py)', () => {
  let previousDefaultAppName: string | undefined;
  let server: AdkApiServer | undefined;

  beforeEach(() => {
    // Process-wide, so it has to be put back or it leaks into other files.
    previousDefaultAppName = process.env.ADK_DEFAULT_APP_NAME;
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (previousDefaultAppName === undefined) {
      delete process.env.ADK_DEFAULT_APP_NAME;
    } else {
      process.env.ADK_DEFAULT_APP_NAME = previousDefaultAppName;
    }
  });

  /** Starts a server whose only app is {@link APP_NAME}, with one session. */
  async function startServer(): Promise<AdkApiServer> {
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    server = new AdkApiServer({
      agentLoader: createStubAgentLoader(APP_NAME),
      sessionService,
    });
    await server.start();
    return server;
  }

  it('test_default_app_name_middleware_and_resolution', async () => {
    process.env.ADK_DEFAULT_APP_NAME = APP_NAME;
    const started = await startServer();

    const session = await getJson<Session>(
      `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}`,
    );
    expect(session.status).toBe(200);
    expect(session.body.id).toBe(SESSION_ID);

    const run = await postJson<Event[]>(`${started.url}/run`, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    });
    expect(run.status).toBe(200);
    expect(Array.isArray(run.body)).toBe(true);
  });

  it('test_default_app_name_not_set_raises_error', async () => {
    delete process.env.ADK_DEFAULT_APP_NAME;
    const started = await startServer();

    const sessionStatus = await getStatus(
      `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}`,
    );
    expect(sessionStatus).toBe(404);

    const run = await postJson<{error: string}>(`${started.url}/run`, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    });
    expect(run.status).toBe(400);
    expect(run.body.error).toContain('app_name is required');
  });
});
