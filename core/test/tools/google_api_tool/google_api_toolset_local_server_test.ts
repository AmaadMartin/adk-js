/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CalendarToolset} from '@google/adk';
import {createServer, Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

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
      'calendar_calendars_get',
      'calendar_calendars_insert',
      'calendar_events_list',
    ]);

    const declaration = tools[0]._getDeclaration();
    expect(declaration.name).toBe('calendar_calendars_get');
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
