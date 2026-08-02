/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiRegistry} from '@google/adk';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

let mockToken: string | null = 'mock_token';
let mockQuotaProjectId: string | undefined;

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockImplementation(() =>
      Promise.resolve({
        getAccessToken: vi.fn().mockResolvedValue({token: mockToken}),
        quotaProjectId: mockQuotaProjectId,
      }),
    ),
  })),
}));

const mockMcpClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {name: 'search', description: 'Search', inputSchema: {}},
      {name: 'fetch', description: 'Fetch', inputSchema: {}},
    ],
  }),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockMcpClient),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

/** Same fixture as the adk-python `MOCK_MCP_SERVERS_LIST`. */
const MOCK_MCP_SERVERS_LIST = {
  mcpServers: [
    {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
    {name: 'test-mcp-server-2', urls: ['mcp.server2.com']},
    {name: 'test-mcp-server-no-url'},
    {name: 'test-mcp-server-http', urls: ['http://mcp.server_http.com']},
    {name: 'test-mcp-server-https', urls: ['https://mcp.server_https.com']},
  ],
};

const PROJECT_ID = 'test-project';
const LIST_URL =
  'https://cloudapiregistry.googleapis.com/v1beta/projects/test-project' +
  '/locations/global/mcpServers?filter=enabled%3Dfalse';

const TransportMock = vi.mocked(StreamableHTTPClientTransport);
const fetchMock = vi.fn<typeof fetch>();

/** A 200 response whose body is `body` serialized as JSON. */
function okResponse(body: unknown): Response {
  return Response.json(body);
}

/** Returns the URL the nth `fetch` call targeted. */
function fetchedUrl(index: number): string {
  return String(fetchMock.mock.calls[index][0]);
}

/** Returns the request init the nth `fetch` call was given. */
function fetchedInit(index: number) {
  return fetchMock.mock.calls[index][1];
}

/** Returns the URL and options the last MCP transport was constructed with. */
function lastTransportCall() {
  const call = TransportMock.mock.calls.at(-1);
  if (!call) {
    expect.fail('StreamableHTTPClientTransport received no call');
  }
  return {url: call[0], headers: call[1]?.requestInit?.headers};
}

/** Resolves a toolset and returns the transport its connection produced. */
async function connectToolset(registry: ApiRegistry, serverName: string) {
  const toolset = await registry.getToolset(serverName);
  await toolset.getTools();
  return lastTransportCall();
}

function newRegistry(): ApiRegistry {
  return new ApiRegistry({projectId: PROJECT_ID, location: 'global'});
}

describe('ApiRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken = 'mock_token';
    mockQuotaProjectId = undefined;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => okResponse(MOCK_MCP_SERVERS_LIST));
    global.fetch = fetchMock;
  });

  describe('construction', () => {
    it('warns that ApiRegistry is deprecated', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      newRegistry();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('ApiRegistry is deprecated');
    });

    it('throws when projectId is empty', () => {
      expect(() => new ApiRegistry({projectId: ''})).toThrow(
        'project_id must be provided',
      );
    });

    it('defaults location to global', async () => {
      const registry = new ApiRegistry({projectId: PROJECT_ID});
      await registry.getToolset('test-mcp-server-1');
      expect(fetchedUrl(0)).toBe(LIST_URL);
    });

    it('performs no I/O', () => {
      newRegistry();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('listing MCP servers', () => {
    it('fetches one page and resolves every server in it', async () => {
      const registry = newRegistry();

      for (const name of [
        'test-mcp-server-1',
        'test-mcp-server-2',
        'test-mcp-server-http',
        'test-mcp-server-https',
      ]) {
        await expect(registry.getToolset(name)).resolves.toBeDefined();
      }
      await expect(
        registry.getToolset('test-mcp-server-no-url'),
      ).rejects.toThrow('has no URLs');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchedUrl(0)).toBe(LIST_URL);
    });

    it('sends Content-Type and Authorization on the list request', async () => {
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');
      expect(fetchedInit(0)).toEqual({
        method: 'GET',
        headers: {
          'Authorization': 'Bearer mock_token',
          'Content-Type': 'application/json',
        },
      });
    });

    it('adds x-goog-user-project to the list request when ADC has a quota project', async () => {
      mockQuotaProjectId = 'quota-project';
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');
      expect(fetchedInit(0)).toEqual({
        method: 'GET',
        headers: {
          'Authorization': 'Bearer mock_token',
          'Content-Type': 'application/json',
          'x-goog-user-project': 'quota-project',
        },
      });
    });

    it('follows nextPageToken and merges every page', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            mcpServers: MOCK_MCP_SERVERS_LIST.mcpServers.slice(0, 2),
            nextPageToken: 'next_page_token',
          }),
        )
        .mockResolvedValueOnce(
          okResponse({mcpServers: MOCK_MCP_SERVERS_LIST.mcpServers.slice(2)}),
        );

      const registry = newRegistry();
      await expect(
        registry.getToolset('test-mcp-server-1'),
      ).resolves.toBeDefined();
      await expect(
        registry.getToolset('test-mcp-server-https'),
      ).resolves.toBeDefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchedUrl(0)).toBe(LIST_URL);
      expect(fetchedUrl(1)).toBe(`${LIST_URL}&pageToken=next_page_token`);
    });

    it('lets a later page overwrite a duplicate from an earlier one', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            mcpServers: [{name: 'dup', urls: ['stale.example.com']}],
            nextPageToken: 'next_page_token',
          }),
        )
        .mockResolvedValueOnce(
          okResponse({
            mcpServers: [{name: 'dup', urls: ['fresh.example.com']}],
          }),
        );

      const {url} = await connectToolset(newRegistry(), 'dup');
      expect(url.toString()).toBe('https://fresh.example.com/');
    });

    it('skips servers returned without a name but keeps their named siblings', async () => {
      fetchMock.mockResolvedValue(
        okResponse({
          mcpServers: [
            {urls: ['mcp.nameless.com']},
            {name: 'named', urls: ['mcp.named.com']},
          ],
        }),
      );
      const registry = newRegistry();
      await expect(registry.getToolset('')).rejects.toThrow(
        'MCP server  not found in API Registry.',
      );
      await expect(registry.getToolset('named')).resolves.toBeDefined();
    });

    it('tolerates a response with no mcpServers field', async () => {
      fetchMock.mockResolvedValue(okResponse({}));
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'not found in API Registry',
      );
    });

    it('wraps a rejected fetch', async () => {
      fetchMock.mockRejectedValue(new Error('Connection failed'));
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry: Connection failed',
      );
    });

    it('wraps a non-2xx response, quoting the status and body', async () => {
      fetchMock.mockImplementation(
        async () => new Response('permission denied', {status: 403}),
      );
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry: request failed with ' +
          'status 403: permission denied',
      );
    });

    it('wraps a body that is not valid JSON', async () => {
      fetchMock.mockImplementation(
        async () => new Response('<html>gateway error</html>', {status: 200}),
      );
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        /^Error fetching MCP servers from API Registry: .*JSON/,
      );
    });

    it('wraps a non-Error rejection', async () => {
      fetchMock.mockRejectedValue('socket hang up');
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry: socket hang up',
      );
    });

    it('fetches the listing once across sequential calls', async () => {
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');
      await registry.getToolset('test-mcp-server-2');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares a single in-flight fetch across concurrent calls', async () => {
      const registry = newRegistry();
      await Promise.all([
        registry.getToolset('test-mcp-server-1'),
        registry.getToolset('test-mcp-server-2'),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('clears the memo after a failure so a later call retries', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Connection failed'));
      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers',
      );
      await expect(
        registry.getToolset('test-mcp-server-1'),
      ).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getToolset', () => {
    it('connects to the resolved URL with only the Authorization header', async () => {
      const {url, headers} = await connectToolset(
        newRegistry(),
        'test-mcp-server-1',
      );
      expect(url.toString()).toBe('https://mcp.server1.com/');
      expect(headers).toEqual({Authorization: 'Bearer mock_token'});
    });

    it('adds x-goog-user-project to the MCP headers when ADC has a quota project', async () => {
      mockQuotaProjectId = 'quota-project';
      const {headers} = await connectToolset(
        newRegistry(),
        'test-mcp-server-1',
      );
      expect(headers).toEqual({
        'Authorization': 'Bearer mock_token',
        'x-goog-user-project': 'quota-project',
      });
    });

    it('applies toolFilter and toolNamePrefix to the returned tools', async () => {
      const registry = newRegistry();
      const toolset = await registry.getToolset('test-mcp-server-1', {
        toolFilter: ['registry_search'],
        toolNamePrefix: 'registry',
      });
      const tools = await toolset.getTools();
      expect(tools.map((tool) => tool.name)).toEqual(['registry_search']);
    });

    it('returns all tools unprefixed when no options are given', async () => {
      const registry = newRegistry();
      const toolset = await registry.getToolset('test-mcp-server-1');
      const tools = await toolset.getTools();
      expect(tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
    });

    it('keeps a URL that already declares the http scheme', async () => {
      const {url} = await connectToolset(newRegistry(), 'test-mcp-server-http');
      expect(url.toString()).toBe('http://mcp.server_http.com/');
    });

    it('keeps a URL that already declares the https scheme', async () => {
      const {url} = await connectToolset(
        newRegistry(),
        'test-mcp-server-https',
      );
      expect(url.toString()).toBe('https://mcp.server_https.com/');
    });

    it('uses the first URL when a server registers several', async () => {
      fetchMock.mockResolvedValue(
        okResponse({
          mcpServers: [
            {name: 'multi', urls: ['first.example.com', 'second.example.com']},
          ],
        }),
      );
      const {url} = await connectToolset(newRegistry(), 'multi');
      expect(url.toString()).toBe('https://first.example.com/');
    });

    it('rejects for a server that is not registered', async () => {
      const registry = newRegistry();
      await expect(registry.getToolset('non-existent-server')).rejects.toThrow(
        'MCP server non-existent-server not found in API Registry.',
      );
    });

    it('rejects for a server registered without URLs', async () => {
      const registry = newRegistry();
      await expect(
        registry.getToolset('test-mcp-server-no-url'),
      ).rejects.toThrow('MCP server test-mcp-server-no-url has no URLs.');
    });

    it('rejects for a server whose urls list is empty', async () => {
      fetchMock.mockResolvedValue(
        okResponse({mcpServers: [{name: 'empty-urls', urls: []}]}),
      );
      const registry = newRegistry();
      await expect(registry.getToolset('empty-urls')).rejects.toThrow(
        'MCP server empty-urls has no URLs.',
      );
    });

    it('rejects when ADC yields no access token', async () => {
      mockToken = null;
      const registry = newRegistry();
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Failed to obtain Google Cloud access token for API Registry.',
      );
    });
  });

  describe('mTLS endpoint selection is not ported', () => {
    const originalMtlsEndpoint = process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];

    afterEach(() => {
      if (originalMtlsEndpoint === undefined) {
        delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
      } else {
        process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = originalMtlsEndpoint;
      }
    });

    it('always targets the non-mTLS host, even with GOOGLE_API_USE_MTLS_ENDPOINT=always', async () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');
      expect(fetchedUrl(0)).toBe(LIST_URL);
    });
  });
});
