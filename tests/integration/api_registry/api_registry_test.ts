/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `ApiRegistry` against a real HTTP server, so the listing crosses a
 * real socket and the server decodes the query string itself. The unit suite
 * stubs `fetch` and cannot see what the far end receives.
 *
 * Only two things are substituted: Application Default Credentials, which no
 * continuous integration job holds, and the request origin, which is rewritten
 * to the local server because the API Registry host is fixed.
 */

import {ApiRegistry} from '@google/adk';
import {createServer, Server} from 'node:http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: async () => ({
      getRequestHeaders: async () =>
        new Headers({authorization: 'Bearer integration-token'}),
      quotaProjectId: 'quota-project',
    }),
  })),
}));

const PAGE_ONE = {
  mcpServers: [{name: 'billing', urls: ['billing-mcp.googleapis.com']}],
  nextPageToken: 'page-two',
};

const PAGE_TWO = {
  mcpServers: [
    {name: 'analytics', urls: ['https://analytics-mcp.example.com']},
  ],
};

interface SeenRequest {
  path: string;
  filter: string | null;
  pageToken: string | null;
  authorization: string | undefined;
  contentType: string | undefined;
  userAgent: string | undefined;
  apiClient: string | string[] | undefined;
  /** A repeated header arrives as an array, so the raw shape is kept. */
  quotaProject: string | string[] | undefined;
}

/** Resolves the headers a toolset presents to its MCP server. */
async function headersFor(toolset: {
  headerProvider?: () =>
    | Promise<Record<string, string>>
    | Record<string, string>;
}): Promise<Record<string, string>> {
  const provider = toolset.headerProvider;
  if (!provider) {
    expect.fail('the toolset carries no header provider');
  }
  return provider();
}

describe('ApiRegistry against a local HTTP server', () => {
  let server: Server;
  let origin: string;
  let seen: SeenRequest[] = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://127.0.0.1');
      seen.push({
        path: url.pathname,
        filter: url.searchParams.get('filter'),
        pageToken: url.searchParams.get('pageToken'),
        authorization: request.headers['authorization'],
        contentType: request.headers['content-type'],
        userAgent: request.headers['user-agent'],
        apiClient: request.headers['x-goog-api-client'],
        quotaProject: request.headers['x-goog-user-project'],
      });
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(url.searchParams.get('pageToken') ? PAGE_TWO : PAGE_ONE),
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the test server did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    seen = [];
    status = 200;
    const realFetch = globalThis.fetch;
    const toLocalServer: typeof fetch = (input, init) => {
      const requested = new URL(String(input));
      return realFetch(
        `${origin}${requested.pathname}${requested.search}`,
        init,
      );
    };
    vi.stubGlobal('fetch', toLocalServer);
  });

  it('lists every page and sends the filter, page token and headers', async () => {
    const registry = new ApiRegistry({
      projectId: 'p1',
      location: 'us-central1',
    });

    await registry.getToolset('billing');

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.path).toBe(
        '/v1beta/projects/p1/locations/us-central1/mcpServers',
      );
      expect(request.filter).toBe('enabled=false');
      expect(request.authorization).toBe('Bearer integration-token');
      expect(request.contentType).toBe('application/json');
      expect(request.quotaProject).toBe('quota-project');
    }
    expect(seen[0].pageToken).toBeNull();
    expect(seen[1].pageToken).toBe('page-two');
  });

  it('builds a toolset for a server from either page', async () => {
    const registry = new ApiRegistry({projectId: 'p1'});

    const billing = await registry.getToolset('billing', {
      toolNamePrefix: 'billing_',
    });
    const analytics = await registry.getToolset('analytics');

    expect(billing.connectionParams.url).toBe(
      'https://billing-mcp.googleapis.com',
    );
    expect(billing.prefix).toBe('billing_');
    expect(analytics.connectionParams.url).toBe(
      'https://analytics-mcp.example.com',
    );
  });

  it('gives the access token to the Google host and not to the other one', async () => {
    const registry = new ApiRegistry({projectId: 'p1'});

    const billing = await registry.getToolset('billing');
    const analytics = await registry.getToolset('analytics');

    expect(await headersFor(billing)).toEqual({
      'Authorization': 'Bearer integration-token',
      'x-goog-user-project': 'quota-project',
    });
    expect(await headersFor(analytics)).toEqual({});
  });

  it('identifies the listing request as ADK traffic', async () => {
    const registry = new ApiRegistry({projectId: 'p1'});

    await registry.getToolset('billing');

    expect(seen[0].apiClient).toContain('google-adk/');
    expect(seen[0].userAgent).toContain('google-adk/');
  });

  it('reports a server-side failure through getToolset', async () => {
    status = 500;
    const registry = new ApiRegistry({projectId: 'p1'});

    await expect(registry.getToolset('billing')).rejects.toThrow(
      'Error fetching MCP servers from API Registry',
    );
  });
});
