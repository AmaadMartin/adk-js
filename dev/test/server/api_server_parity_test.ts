/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports of the `ADK_DEFAULT_APP_NAME` tests from
 * `adk-python tests/unittests/cli/test_fast_api.py` @ main. The test names are
 * kept verbatim so a reviewer can grep both repositories for the same string.
 *
 * `test_run_live_websocket_default_app_name` is not ported: adk-js serves no
 * `/run_live` websocket endpoint.
 */

import {
  BaseSessionService,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Session,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  AdkApiServer,
  MISSING_APP_NAME_ERROR,
} from '../../src/server/adk_api_server.js';
import {DEFAULT_APP_NAME_ENV_VAR} from '../../src/server/default_app_rewrite.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

class EchoAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'Hello'}], role: 'model'},
    });
  }
}

function agentLoaderFor(agent: LlmAgent, appName: string): AgentLoader {
  return {
    listAgents: () => Promise.resolve([appName]),
    getAgentFile: () =>
      Promise.resolve({
        load: () => Promise.resolve(agent),
        async [Symbol.asyncDispose](): Promise<void> {
          return;
        },
      }),
  } as unknown as AgentLoader;
}

const RUN_PAYLOAD_WITHOUT_APP_NAME = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  newMessage: {role: 'user', parts: [{text: 'Hello'}]},
};

describe('ADK_DEFAULT_APP_NAME parity with adk-python', () => {
  let sessionService: BaseSessionService;
  let server: AdkApiServer | undefined;
  let originalDefaultApp: string | undefined;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    originalDefaultApp = process.env[DEFAULT_APP_NAME_ENV_VAR];
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (originalDefaultApp === undefined) {
      delete process.env[DEFAULT_APP_NAME_ENV_VAR];
    } else {
      process.env[DEFAULT_APP_NAME_ENV_VAR] = originalDefaultApp;
    }
  });

  /**
   * The server reads the environment variable in its constructor, so every
   * test sets it before starting the server.
   */
  async function startServer(appName: string): Promise<AdkApiServer> {
    server = new AdkApiServer({
      agentLoader: agentLoaderFor(new EchoAgent({name: 'echo'}), appName),
      sessionService,
    });
    await server.start();

    return server;
  }

  it('test_default_app_name_middleware_and_resolution', async () => {
    process.env[DEFAULT_APP_NAME_ENV_VAR] = APP_NAME;
    const started = await startServer(APP_NAME);
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      state: {},
    });

    const getResponse = await fetch(
      `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}`,
    );
    expect(getResponse.status).toBe(200);
    expect(((await getResponse.json()) as Session).id).toBe(SESSION_ID);

    const runResponse = await fetch(`${started.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(RUN_PAYLOAD_WITHOUT_APP_NAME),
    });
    expect(runResponse.status).toBe(200);
    expect(await runResponse.json()).toBeInstanceOf(Array);
  });

  it('test_default_app_name_not_set_raises_error', async () => {
    delete process.env[DEFAULT_APP_NAME_ENV_VAR];
    const started = await startServer(APP_NAME);

    const getResponse = await fetch(
      `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}`,
    );
    expect(getResponse.status).toBe(404);

    const runResponse = await fetch(`${started.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(RUN_PAYLOAD_WITHOUT_APP_NAME),
    });
    expect(runResponse.status).toBe(400);
    expect((await runResponse.json()) as {error: string}).toEqual({
      error: MISSING_APP_NAME_ERROR,
    });
  });

  /**
   * Ported with the precedence half dropped: adk-js has no single-agent mode
   * that overrides `ADK_DEFAULT_APP_NAME`, so only the environment variable
   * decides which app serves an app-name-less path.
   */
  it('test_single_agent_mode_sets_default_app', async () => {
    const soleApp = 'my_only_agent';
    process.env[DEFAULT_APP_NAME_ENV_VAR] = soleApp;
    const started = await startServer(soleApp);
    await sessionService.createSession({
      appName: soleApp,
      userId: USER_ID,
      sessionId: SESSION_ID,
      state: {},
    });

    const response = await fetch(
      `${started.url}/users/${USER_ID}/sessions/${SESSION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as Session).appName).toBe(soleApp);
  });
});
