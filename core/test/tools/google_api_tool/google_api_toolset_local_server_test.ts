/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createEventActions,
  createSession,
  DiscoveryDocument,
  GoogleApiTool,
  GoogleApiToolset,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {createServer, IncomingHttpHeaders, Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

const FUNCTION_CALL_ID = 'call-1';
const ACCESS_TOKEN = 'test-access-token';
const DEVELOPER_TOKEN = 'test-developer-token';

/** One request the local server answered. */
interface ReceivedRequest {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Binds the server to a free loopback port and reports which one. */
function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: FUNCTION_CALL_ID,
    eventActions: createEventActions(),
  });
}

/**
 * Drives `GoogleApiToolset` against a real HTTP server: it fetches the
 * Discovery document over the network, builds the tools from it, and runs one
 * of them over a real `fetch`. Nothing is mocked, so the request asserted here
 * is the request that left the process.
 */
describe('GoogleApiToolset against a local server', () => {
  let server: Server;
  let baseUrl: string;
  let discoveryUrl: string;
  let received: ReceivedRequest[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? '';
      received.push({url, headers: request.headers});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        url.startsWith('/discovery')
          ? JSON.stringify(localDiscoveryDocument())
          : JSON.stringify({items: ['event-1']}),
      );
    });

    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
    discoveryUrl = `${baseUrl}/discovery`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /** The Calendar fixture, served by this test's own server. */
  function localDiscoveryDocument(): DiscoveryDocument {
    return {...CALENDAR_DISCOVERY_DOCUMENT, rootUrl: `${baseUrl}/`};
  }

  function makeToolset(): GoogleApiToolset {
    return new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      discoveryUrl,
      additionalHeaders: {'developer-token': DEVELOPER_TOKEN},
    });
  }

  /** Returns the named tool, or fails the test. */
  async function toolNamed(
    toolset: GoogleApiToolset,
    name: string,
  ): Promise<GoogleApiTool> {
    const tool = (await toolset.getTools()).find((each) => each.name === name);
    if (!tool) {
      return expect.fail(`the toolset generated no tool named ${name}`);
    }
    return tool;
  }

  it('builds its tools from the discovery document it fetched', async () => {
    received = [];
    const toolset = makeToolset();

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'calendar_calendars_get',
      'calendar_calendars_insert',
      'calendar_events_list',
    ]);
    expect(received.map((request) => request.url)).toEqual(['/discovery']);
  });

  it('asks for a credential before it calls the api', async () => {
    const tool = await toolNamed(makeToolset(), 'calendar_events_list');
    const context = createToolContext();

    await tool.runAsync({args: {calendar_id: 'cal-1'}, toolContext: context});

    expect(
      context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
    ).toBeDefined();
  });

  it('sends the authorized request with the additional headers', async () => {
    const tool = await toolNamed(makeToolset(), 'calendar_events_list');
    const context = createToolContext();
    // The first call has no credential, so it asks for one. Answering it is
    // what the host does once the user has completed the consent flow.
    await tool.runAsync({args: {calendar_id: 'cal-1'}, toolContext: context});
    const requested = context.actions.requestedAuthConfigs[FUNCTION_CALL_ID];
    if (!requested) {
      return expect.fail('the tool asked for no credential');
    }
    context.state.set(`temp:${requested.credentialKey}`, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: ACCESS_TOKEN},
    });

    received = [];
    const result = await tool.runAsync({
      args: {calendar_id: 'cal-1', max_results: 5},
      toolContext: context,
    });

    expect(result).toEqual({items: ['event-1']});
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe(
      '/calendar/v3/calendars/cal-1/events?maxResults=5',
    );
    expect(received[0]?.headers['developer-token']).toBe(DEVELOPER_TOKEN);
    expect(received[0]?.headers['authorization']).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });
});
