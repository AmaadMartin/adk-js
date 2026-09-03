/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  CalendarToolset,
  Context,
  createSession,
  DiscoveryDocument,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {createServer, Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

/**
 * A context that already holds the exchanged OpenID Connect credential, so a
 * tool run reaches the transport instead of stopping to ask for consent.
 */
function createAuthorizedContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        state: {
          'openIdConnect_existing_exchanged_credential': {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'test-token'}},
          },
        },
      }),
      pluginManager: new PluginManager(),
    }),
  });
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

/**
 * Drives `CalendarToolset` against a Discovery document served over a real
 * HTTP connection, so the transport, the converter and the spec parser all run
 * for real.
 */
describe('GoogleApiToolset against a local discovery server', () => {
  let server: Server;
  let discoveryUrl: string;
  let requestedPaths: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '');
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT));
    });

    const port = await listenOnFreePort(server);
    discoveryUrl = `http://127.0.0.1:${port}/discovery/{api}/{apiVersion}.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('builds callable tools from the served document', async () => {
    requestedPaths = [];
    const toolset = new CalendarToolset({discoveryUrl});

    const tools = await toolset.getTools();

    expect(requestedPaths).toEqual(['/discovery/calendar/v3.json']);
    expect(tools.map((tool) => tool.name)).toEqual([
      'calendar.calendars.get',
      'calendar.calendars.insert',
      'calendar.events.list',
    ]);

    const declaration = tools[0]._getDeclaration();
    expect(declaration.name).toBe('calendar.calendars.get');
    expect(declaration.parameters?.properties).toHaveProperty('calendar_id');

    await toolset.close();
  });

  it('rejects when the server answers with something else', async () => {
    const badServer = createServer((_request, response) => {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end('<html><body>sign in to continue</body></html>');
    });
    const port = await listenOnFreePort(badServer);
    const toolset = new CalendarToolset({
      discoveryUrl: `http://127.0.0.1:${port}/rest`,
    });

    try {
      await expect(toolset.getTools()).rejects.toThrow(
        /not a discovery document/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        badServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

/**
 * Drives a tool call over a real HTTP connection with no client certificate
 * configured, so the transport code the mutual-TLS support added is shown to
 * be inert on the default path.
 */
describe('a Google API tool request without a client certificate', () => {
  let server: Server;
  let discoveryUrl: string;
  let apiPaths: string[] = [];

  beforeAll(async () => {
    let origin = '';
    server = createServer((request, response) => {
      const url = request.url ?? '';
      response.writeHead(200, {'content-type': 'application/json'});
      if (url.startsWith('/discovery/')) {
        response.end(
          JSON.stringify({
            ...CALENDAR_DISCOVERY_DOCUMENT,
            rootUrl: `${origin}/`,
          } satisfies DiscoveryDocument),
        );
        return;
      }
      apiPaths.push(url);
      response.end(JSON.stringify({summary: 'a calendar'}));
    });

    const port = await listenOnFreePort(server);
    origin = `http://127.0.0.1:${port}`;
    discoveryUrl = `${origin}/discovery/{api}/{apiVersion}.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('reaches the served api and returns its body', async () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    apiPaths = [];
    const toolset = new CalendarToolset({discoveryUrl});

    const [getCalendar] = await toolset.getTools();
    const result = await getCalendar.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: createAuthorizedContext(),
    });

    expect(apiPaths).toEqual(['/calendar/v3/calendars/primary']);
    expect(result).toEqual({summary: 'a calendar'});

    await toolset.close();
  });
});
