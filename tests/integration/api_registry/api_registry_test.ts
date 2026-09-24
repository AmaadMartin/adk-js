/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the API Registry listing against a real HTTP server: real sockets,
 * real query encoding, real headers and real pagination. Nothing is stubbed, so
 * the test needs no credentials and reaches no Google endpoint.
 */

import * as http from 'node:http';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {listApiRegistryMcpServers} from '../../../core/src/integrations/api_registry/api_registry.js';

const PROJECT_ID = 'test-project';
const LOCATION = 'global';

const PAGE_ONE = {
  mcpServers: [
    {
      name: 'projects/test-project/locations/global/mcpServers/weather',
      urls: ['https://weather.example.com/mcp'],
    },
    {
      name: 'projects/test-project/locations/global/mcpServers/finance',
      urls: ['finance.example.com/mcp'],
    },
  ],
  nextPageToken: 'page-two',
};

const PAGE_TWO = {
  mcpServers: [
    {
      name: 'projects/test-project/locations/global/mcpServers/calendar',
      urls: ['https://calendar.example.com/mcp'],
    },
  ],
};

/** One request the fixture server received. */
interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
}

describe('API Registry listing against a local server', () => {
  let server: http.Server;
  let baseUrl: string;
  let received: RecordedRequest[];
  let status = 200;
  let body: string | undefined;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      received.push({url: request.url ?? '', headers: request.headers});
      if (body !== undefined) {
        response.writeHead(status);
        response.end(body);
        return;
      }
      const page = request.url?.includes('pageToken=page-two')
        ? PAGE_TWO
        : PAGE_ONE;
      response.writeHead(status, {'Content-Type': 'application/json'});
      response.end(JSON.stringify(page));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      expect.fail('the fixture server did not report a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    received = [];
    status = 200;
    body = undefined;
  });

  it('follows every page and indexes the servers by name', async () => {
    const servers = await listApiRegistryMcpServers(
      baseUrl,
      PROJECT_ID,
      LOCATION,
      {
        'Content-Type': 'application/json',
        'x-goog-user-project': 'quota-project',
      },
    );

    expect([...servers.keys()]).toEqual([
      'projects/test-project/locations/global/mcpServers/weather',
      'projects/test-project/locations/global/mcpServers/finance',
      'projects/test-project/locations/global/mcpServers/calendar',
    ]);
    expect(received).toHaveLength(2);
  });

  it('sends the filter on both pages and the page token on the second', async () => {
    await listApiRegistryMcpServers(baseUrl, PROJECT_ID, LOCATION, {});

    expect(received[0].url).toBe(
      `/v1beta/projects/${PROJECT_ID}/locations/${LOCATION}/mcpServers?filter=enabled%3Dfalse`,
    );
    expect(received[1].url).toBe(
      `/v1beta/projects/${PROJECT_ID}/locations/${LOCATION}/mcpServers` +
        '?filter=enabled%3Dfalse&pageToken=page-two',
    );
  });

  it('sends the caller headers on every page', async () => {
    await listApiRegistryMcpServers(baseUrl, PROJECT_ID, LOCATION, {
      'Authorization': 'Bearer integration-token',
      'x-goog-user-project': 'quota-project',
    });

    for (const request of received) {
      expect(request.headers['authorization']).toBe('Bearer integration-token');
      expect(request.headers['x-goog-user-project']).toBe('quota-project');
    }
  });

  it('reports a server error as a listing failure', async () => {
    status = 500;
    body = 'boom';

    await expect(
      listApiRegistryMcpServers(baseUrl, PROJECT_ID, LOCATION, {}),
    ).rejects.toThrow(
      'Error fetching MCP servers from API Registry: request failed with status 500',
    );
  });

  it('reports an unparseable body as a listing failure', async () => {
    body = 'not json';

    await expect(
      listApiRegistryMcpServers(baseUrl, PROJECT_ID, LOCATION, {}),
    ).rejects.toThrow('Error fetching MCP servers from API Registry');
  });
});
