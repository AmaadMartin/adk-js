/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The first block is ported from adk-python
// tests/unittests/integrations/api_registry/test_api_registry.py at
// google/adk-python main. Each `it` keeps its Python test name.

import {ApiRegistry, ReadonlyContext} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';
import {
  getWithClientCert,
  loadDefaultClientCerts,
} from '../../src/utils/mtls_utils.js';

let quotaProjectId: string | undefined;
let authFailure: Error | undefined;

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockImplementation(() => {
      if (authFailure) {
        return Promise.reject(authFailure);
      }
      return Promise.resolve({
        getRequestHeaders: vi
          .fn()
          .mockResolvedValue(new Headers({authorization: 'Bearer mock_token'})),
        quotaProjectId,
      });
    }),
  })),
}));

// The certificate-presenting path is covered by core/test/utils/mtls_utils_test.ts
// against real sockets; here it stands in for the transport, the way the Python
// test stands in for AuthorizedSession.
vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  loadDefaultClientCerts: vi.fn(),
  getWithClientCert: vi.fn(),
}));

const PROJECT_ID = 'test-project';
const LOCATION = 'global';

const MOCK_MCP_SERVERS_LIST = {
  mcpServers: [
    {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
    {name: 'test-mcp-server-2', urls: ['mcp.server2.com']},
    {name: 'test-mcp-server-no-url'},
    {name: 'test-mcp-server-http', urls: ['http://mcp.server_http.com']},
    {name: 'test-mcp-server-https', urls: ['https://mcp.server_https.com']},
  ],
};

const LISTING_URL =
  `https://cloudapiregistry.googleapis.com/v1beta/projects/${PROJECT_ID}` +
  `/locations/${LOCATION}/mcpServers`;

let fetchMock: ReturnType<typeof vi.fn>;

/** Queues `pages` as the successive listing responses. */
function respondWith(...pages: unknown[]): void {
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(page), {status: 200}),
    );
  }
}

/** The URL of the nth listing request, counting from zero. */
function requestedUrl(call: number): string {
  return String(fetchMock.mock.calls[call][0]);
}

/** The headers of the nth listing request, counting from zero. */
function requestedHeaders(call: number): Record<string, string> {
  const init = fetchMock.mock.calls[call][1] as {
    headers: Record<string, string>;
  };
  return init.headers;
}

/** Resolves the headers a toolset sends when it connects. */
async function toolsetHeaders(
  registry: ApiRegistry,
  serverName: string,
  context?: ReadonlyContext,
): Promise<Record<string, string>> {
  const toolset = await registry.getToolset(serverName);
  if (!toolset.headerProvider) {
    expect.fail('the toolset carries no header provider');
  }
  return toolset.headerProvider(context);
}

beforeEach(() => {
  quotaProjectId = undefined;
  authFailure = undefined;
  delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
  delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(loadDefaultClientCerts).mockResolvedValue(undefined);
  vi.mocked(getWithClientCert).mockReset();
  resetDeprecationWarnings();
});

afterEach(() => {
  // Only the global stub is undone: vi.restoreAllMocks() would also strip the
  // implementations off the mocked modules above.
  vi.unstubAllGlobals();
});

describe('ApiRegistry ported reference tests', () => {
  it('test_deprecation_warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    expect(warn.mock.calls.flat().join(' ')).toContain(
      'ApiRegistry is deprecated',
    );
    warn.mockRestore();
  });

  it('test_init_success', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({
      projectId: PROJECT_ID,
      location: LOCATION,
    });
    // Every listed server is indexed: the four with a URL resolve, and the
    // fifth is found but reported as having none.
    for (const name of [
      'test-mcp-server-1',
      'test-mcp-server-2',
      'test-mcp-server-http',
      'test-mcp-server-https',
    ]) {
      await expect(registry.getToolset(name)).resolves.toBeDefined();
    }
    await expect(registry.getToolset('test-mcp-server-no-url')).rejects.toThrow(
      'has no URLs',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl(0)).toBe(`${LISTING_URL}?filter=enabled%3Dfalse`);
    expect(requestedHeaders(0)['Content-Type']).toBe('application/json');
    expect(requestedHeaders(0)['Authorization']).toBe('Bearer mock_token');
  });

  it('test_init_with_quota_project_id_success', async () => {
    quotaProjectId = 'quota-project';
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedHeaders(0)['x-goog-user-project']).toBe('quota-project');
  });

  it('test_init_with_pagination_success', async () => {
    respondWith(
      {
        mcpServers: MOCK_MCP_SERVERS_LIST.mcpServers.slice(0, 2),
        nextPageToken: 'next_page_token',
      },
      {mcpServers: MOCK_MCP_SERVERS_LIST.mcpServers.slice(2)},
    );

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(
      registry.getToolset('test-mcp-server-https'),
    ).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrl(0)).toBe(`${LISTING_URL}?filter=enabled%3Dfalse`);
    expect(requestedUrl(1)).toBe(
      `${LISTING_URL}?filter=enabled%3Dfalse&pageToken=next_page_token`,
    );
  });

  it('test_init_http_error', async () => {
    fetchMock.mockRejectedValue(new Error('Connection failed'));

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
      'Error fetching MCP servers',
    );
  });

  it('test_init_bad_response', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', {status: 404}));

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
      'Error fetching MCP servers',
    );
  });

  it('test_get_toolset_success', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    const toolset = await registry.getToolset('test-mcp-server-1');

    expect(toolset.connectionParams.url).toBe('https://mcp.server1.com');
    // adk-python bakes the headers into the connection parameters; adk-js
    // resolves them per connection through the header provider.
    await expect(
      toolsetHeaders(registry, 'test-mcp-server-1'),
    ).resolves.toEqual({Authorization: 'Bearer mock_token'});
  });

  it('test_get_toolset_with_quota_project_id_success', async () => {
    quotaProjectId = 'quota-project';
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});

    await expect(
      toolsetHeaders(registry, 'test-mcp-server-1'),
    ).resolves.toEqual({
      'Authorization': 'Bearer mock_token',
      'x-goog-user-project': 'quota-project',
    });
  });

  it('test_get_toolset_with_filter_and_prefix', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    const toolset = await registry.getToolset('test-mcp-server-1', {
      toolFilter: ['tool1'],
      toolNamePrefix: 'prefix_',
    });

    expect(toolset.toolFilter).toEqual(['tool1']);
    expect(toolset.prefix).toBe('prefix_');
  });

  it('test_get_toolset_url_scheme', async () => {
    const cases = [
      ['test-mcp-server-http', 'http://mcp.server_http.com'],
      ['test-mcp-server-https', 'https://mcp.server_https.com'],
    ];
    for (const [serverName, url] of cases) {
      respondWith(MOCK_MCP_SERVERS_LIST);
      const registry = new ApiRegistry({projectId: PROJECT_ID});
      const toolset = await registry.getToolset(serverName);
      expect(toolset.connectionParams.url).toBe(url);
    }
  });

  it('test_get_toolset_server_not_found', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('non-existent-server')).rejects.toThrow(
      'not found in API Registry',
    );
  });

  it('test_get_toolset_server_no_url', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-no-url')).rejects.toThrow(
      'has no URLs',
    );
  });

  it('test_init_configures_mtls', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    const certs = {cert: 'cert-pem', key: 'key-pem'};
    vi.mocked(loadDefaultClientCerts).mockResolvedValue(certs);
    vi.mocked(getWithClientCert).mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify(MOCK_MCP_SERVERS_LIST),
    });

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(
      registry.getToolset('test-mcp-server-1'),
    ).resolves.toBeDefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getWithClientCert).toHaveBeenCalledTimes(1);
    const [url, , presented] = vi.mocked(getWithClientCert).mock.calls[0];
    expect(url).toContain('cloudapiregistry.mtls.googleapis.com');
    expect(presented).toBe(certs);
  });
});

describe('ApiRegistry', () => {
  it('identifies the listing request as ADK traffic', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    expect(requestedHeaders(0)['x-goog-api-client']).toContain('google-adk/');
    expect(requestedHeaders(0)['user-agent']).toContain('google-adk/');
  });

  it('rejects an empty project id', () => {
    expect(() => new ApiRegistry({projectId: ''})).toThrow(
      'projectId must be provided',
    );
  });

  it('lists the global location by default', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    expect(registry.location).toBe('global');
    expect(requestedUrl(0)).toContain('/locations/global/mcpServers');
  });

  it('lists the location it is given', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({
      projectId: PROJECT_ID,
      location: 'us-central1',
    });
    await registry.getToolset('test-mcp-server-1');

    expect(requestedUrl(0)).toContain('/locations/us-central1/mcpServers');
  });

  it('prefixes a registered URL that carries no scheme', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    const toolset = await registry.getToolset('test-mcp-server-2');

    expect(toolset.connectionParams.url).toBe('https://mcp.server2.com');
  });

  it('withholds the credentials from a cleartext server URL', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});

    await expect(
      toolsetHeaders(registry, 'test-mcp-server-http'),
    ).resolves.toEqual({});
    await expect(
      toolsetHeaders(registry, 'test-mcp-server-https'),
    ).resolves.toEqual({Authorization: 'Bearer mock_token'});
  });

  it('merges the caller header provider over the credentials', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);
    const seen: Array<ReadonlyContext | undefined> = [];

    const registry = new ApiRegistry({
      projectId: PROJECT_ID,
      headerProvider: (context) => {
        seen.push(context);
        return {'x-caller': 'yes'};
      },
    });

    await expect(
      toolsetHeaders(registry, 'test-mcp-server-1'),
    ).resolves.toEqual({
      'Authorization': 'Bearer mock_token',
      'x-caller': 'yes',
    });
    expect(seen).toEqual([undefined]);
  });

  it('calls the caller header provider on a cleartext URL too', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({
      projectId: PROJECT_ID,
      headerProvider: () => ({'x-caller': 'yes'}),
    });

    await expect(
      toolsetHeaders(registry, 'test-mcp-server-http'),
    ).resolves.toEqual({'x-caller': 'yes'});
  });

  it('does not index a server whose name is missing or empty', async () => {
    respondWith({
      mcpServers: [
        {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
        {urls: ['mcp.nameless.com']},
        {name: '', urls: ['mcp.empty-name.com']},
      ],
    });

    const registry = new ApiRegistry({projectId: PROJECT_ID});

    const toolset = await registry.getToolset('test-mcp-server-1');
    expect(toolset.connectionParams.url).toBe('https://mcp.server1.com');
    await expect(registry.getToolset('')).rejects.toThrow(
      'not found in API Registry',
    );
    await expect(registry.getToolset('undefined')).rejects.toThrow(
      'not found in API Registry',
    );
  });

  it('keeps the last server when a name repeats across pages', async () => {
    respondWith(
      {
        mcpServers: [{name: 'duplicate', urls: ['https://first.example.com']}],
        nextPageToken: 'page-2',
      },
      {mcpServers: [{name: 'duplicate', urls: ['https://second.example.com']}]},
    );

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    const toolset = await registry.getToolset('duplicate');

    expect(toolset.connectionParams.url).toBe('https://second.example.com');
  });

  it('lists once however many toolsets are requested', async () => {
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');
    await registry.getToolset('test-mcp-server-2');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not raise an unhandled rejection when nobody queries a failed listing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    fetchMock.mockRejectedValue(new Error('Connection failed'));

    new ApiRegistry({projectId: PROJECT_ID});
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('reports an unparseable listing body', async () => {
    fetchMock.mockResolvedValue(new Response('not json', {status: 200}));

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
      'Error fetching MCP servers from API Registry',
    );
  });

  it('propagates a credentials failure unwrapped', async () => {
    authFailure = new Error('could not load Application Default Credentials');

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
      'could not load Application Default Credentials',
    );
    await expect(registry.getToolset('test-mcp-server-1')).rejects.not.toThrow(
      'Error fetching MCP servers',
    );
  });

  it('tolerates a page with no mcpServers field', async () => {
    respondWith({});

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
      'not found in API Registry',
    );
  });

  it('rejects a server whose urls list is empty', async () => {
    respondWith({mcpServers: [{name: 'empty-urls', urls: []}]});

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await expect(registry.getToolset('empty-urls')).rejects.toThrow(
      'has no URLs',
    );
  });
});

describe('ApiRegistry host selection', () => {
  const certs = {cert: 'cert-pem', key: 'key-pem'};

  /** Lists once with the given setting and returns the host that was called. */
  async function listedHost(
    setting: string | undefined,
    hasCert: boolean,
  ): Promise<string> {
    if (setting === undefined) {
      delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
    } else {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = setting;
    }
    if (hasCert) {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      vi.mocked(loadDefaultClientCerts).mockResolvedValue(certs);
      vi.mocked(getWithClientCert).mockResolvedValue({
        ok: true,
        status: 200,
        body: JSON.stringify(MOCK_MCP_SERVERS_LIST),
      });
    } else {
      respondWith(MOCK_MCP_SERVERS_LIST);
    }

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    const url = hasCert
      ? String(vi.mocked(getWithClientCert).mock.calls[0][0])
      : requestedUrl(0);
    return new URL(url).host;
  }

  it('uses the mTLS host whenever the setting is always', async () => {
    await expect(listedHost('always', false)).resolves.toBe(
      'cloudapiregistry.mtls.googleapis.com',
    );
  });

  it('uses the mTLS host for always even with a certificate', async () => {
    await expect(listedHost('always', true)).resolves.toBe(
      'cloudapiregistry.mtls.googleapis.com',
    );
  });

  it('uses the plain host whenever the setting is never', async () => {
    await expect(listedHost('never', true)).resolves.toBe(
      'cloudapiregistry.googleapis.com',
    );
  });

  it('uses the mTLS host under auto only with a certificate', async () => {
    await expect(listedHost('auto', true)).resolves.toBe(
      'cloudapiregistry.mtls.googleapis.com',
    );
  });

  it('uses the plain host under auto without a certificate', async () => {
    await expect(listedHost('AUTO', false)).resolves.toBe(
      'cloudapiregistry.googleapis.com',
    );
  });

  it('treats an unrecognised setting as auto', async () => {
    await expect(listedHost('banana', true)).resolves.toBe(
      'cloudapiregistry.mtls.googleapis.com',
    );
  });

  it('treats an unset setting as auto', async () => {
    await expect(listedHost(undefined, false)).resolves.toBe(
      'cloudapiregistry.googleapis.com',
    );
  });

  it('uses the plain host when certificate discovery finds nothing', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    vi.mocked(loadDefaultClientCerts).mockResolvedValue(undefined);
    respondWith(MOCK_MCP_SERVERS_LIST);

    const registry = new ApiRegistry({projectId: PROJECT_ID});
    await registry.getToolset('test-mcp-server-1');

    expect(getWithClientCert).not.toHaveBeenCalled();
    expect(new URL(requestedUrl(0)).host).toBe(
      'cloudapiregistry.googleapis.com',
    );
  });
});
