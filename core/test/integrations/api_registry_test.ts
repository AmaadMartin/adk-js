/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/integrations/api_registry/test_api_registry.py`
 * on `google/adk-python` `main`. Every reference test keeps its Python name as
 * its `it(...)` string, so the two suites can be compared by name. Tests with
 * no reference counterpart are grouped separately at the end.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiRegistry} from '../../src/index.js';
import {getTrackingHeaders} from '../../src/utils/client_labels.js';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';
import {
  clientCertsToPresent,
  getWithClientCert,
} from '../../src/utils/mtls_utils.js';

const authState = vi.hoisted(() => ({
  token: 'mock_token' as string | undefined,
  quotaProjectId: undefined as string | undefined,
  failure: undefined as Error | undefined,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: async () => {
      if (authState.failure) {
        throw authState.failure;
      }
      return {
        getRequestHeaders: async () =>
          new Headers(
            authState.token ? {authorization: `Bearer ${authState.token}`} : {},
          ),
        quotaProjectId: authState.quotaProjectId,
      };
    },
  })),
}));

vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/mtls_utils.js')>();
  return {
    ...actual,
    clientCertsToPresent: vi.fn(async () => undefined),
    getWithClientCert: vi.fn(),
  };
});

const PROJECT_ID = 'test-project';
const LOCATION = 'global';
const LIST_URL =
  'https://cloudapiregistry.googleapis.com/v1beta/projects/test-project/locations/global/mcpServers';
const MTLS_LIST_URL =
  'https://cloudapiregistry.mtls.googleapis.com/v1beta/projects/test-project/locations/global/mcpServers';

/** The reference fixture, entry for entry. */
const MOCK_MCP_SERVERS_LIST = {
  mcpServers: [
    {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
    {name: 'test-mcp-server-2', urls: ['mcp.server2.com']},
    {name: 'test-mcp-server-no-url'},
    {name: 'test-mcp-server-http', urls: ['http://mcp.server_http.com']},
    {name: 'test-mcp-server-https', urls: ['https://mcp.server_https.com']},
    {name: 'test-mcp-server-google', urls: ['mcp.us-central1.googleapis.com']},
    {
      name: 'test-mcp-server-google-http',
      urls: ['http://mcp.us-central1.googleapis.com'],
    },
  ],
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

function newRegistry(options?: {
  location?: string;
  headerProvider?: () => Record<string, string>;
}): ApiRegistry {
  return new ApiRegistry({
    projectId: PROJECT_ID,
    location: options?.location ?? LOCATION,
    headerProvider: options?.headerProvider,
  });
}

/**
 * Resolves the headers the toolset presents to the MCP server. Asserting on
 * `connectionParams` alone would pass against a port that never attaches
 * credentials, because the credentials live behind the header provider.
 */
async function resolvedHeaders(toolset: {
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

describe('ApiRegistry', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    authState.token = 'mock_token';
    authState.quotaProjectId = undefined;
    authState.failure = undefined;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(MOCK_MCP_SERVERS_LIST));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(clientCertsToPresent).mockResolvedValue(undefined);
    vi.mocked(getWithClientCert).mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  describe('ported from adk-python', () => {
    it('test_deprecation_warning', () => {
      newRegistry();

      expect(logger.warn).toHaveBeenCalledWith(
        'ApiRegistry is deprecated. Use AgentRegistry from @google/adk instead.',
      );
    });

    it('test_init_success', async () => {
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${LIST_URL}?filter=enabled%3Dfalse`,
        {
          method: 'GET',
          headers: {
            ...getTrackingHeaders(),
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mock_token',
          },
        },
      );

      // All seven listed servers are indexed: the six with a URL resolve, and
      // the seventh is reached far enough to report that it has none.
      for (const name of [
        'test-mcp-server-2',
        'test-mcp-server-http',
        'test-mcp-server-https',
        'test-mcp-server-google',
        'test-mcp-server-google-http',
      ]) {
        await expect(registry.getToolset(name)).resolves.toBeDefined();
      }
      await expect(
        registry.getToolset('test-mcp-server-no-url'),
      ).rejects.toThrow('has no URLs');
    });

    it('test_init_with_quota_project_id_success', async () => {
      authState.quotaProjectId = 'quota-project';

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${LIST_URL}?filter=enabled%3Dfalse`,
        {
          method: 'GET',
          headers: {
            ...getTrackingHeaders(),
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mock_token',
            'x-goog-user-project': 'quota-project',
          },
        },
      );
    });

    it('test_registry_request_identifies_adk', async () => {
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      const init = fetchMock.mock.calls[0][1];
      if (!init) {
        expect.fail('the listing request carried no init object');
      }
      const headers = init.headers;
      if (!headers || headers instanceof Headers || Array.isArray(headers)) {
        expect.fail('the listing headers are not a plain record');
      }
      expect(headers['x-goog-api-client']).toContain('google-adk/');
      expect(headers['user-agent']).toContain('google-adk/');
    });

    it('test_init_with_pagination_success', async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            mcpServers: [
              {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
              {name: 'test-mcp-server-2', urls: ['mcp.server2.com']},
            ],
            nextPageToken: 'next_page_token',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            mcpServers: [
              {name: 'test-mcp-server-no-url'},
              {
                name: 'test-mcp-server-http',
                urls: ['http://mcp.server_http.com'],
              },
              {
                name: 'test-mcp-server-https',
                urls: ['https://mcp.server_https.com'],
              },
            ],
          }),
        );

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `${LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `${LIST_URL}?filter=enabled%3Dfalse&pageToken=next_page_token`,
        expect.anything(),
      );

      // Both pages landed in one index.
      await expect(
        registry.getToolset('test-mcp-server-https'),
      ).resolves.toBeDefined();
    });

    it('test_init_http_error', async () => {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new Error('Connection failed'));

      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry: Connection failed',
      );
    });

    it('test_init_bad_response', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response('Not Found', {status: 404}));

      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry',
      );
    });

    it('test_get_toolset_success', async () => {
      const registry = newRegistry();

      const toolset = await registry.getToolset('test-mcp-server-1');

      expect(toolset.connectionParams).toEqual({
        type: 'StreamableHTTPConnectionParams',
        url: 'https://mcp.server1.com',
      });
      // mcp.server1.com is not a Google API host, so it gets no credentials.
      expect(await resolvedHeaders(toolset)).toEqual({});
      expect(toolset.toolFilter).toEqual([]);
      expect(toolset.prefix).toBeUndefined();
    });

    it('test_get_toolset_with_quota_project_id_success', async () => {
      authState.quotaProjectId = 'quota-project';
      const registry = newRegistry();

      const toolset = await registry.getToolset('test-mcp-server-google');

      expect(toolset.connectionParams.url).toBe(
        'https://mcp.us-central1.googleapis.com',
      );
      expect(await resolvedHeaders(toolset)).toEqual({
        'Authorization': 'Bearer mock_token',
        'x-goog-user-project': 'quota-project',
      });
    });

    it('test_get_toolset_with_filter_and_prefix', async () => {
      const registry = newRegistry();

      const toolset = await registry.getToolset('test-mcp-server-1', {
        toolFilter: ['tool1'],
        toolNamePrefix: 'prefix_',
      });

      expect(toolset.toolFilter).toEqual(['tool1']);
      expect(toolset.prefix).toBe('prefix_');
      expect(toolset.connectionParams.url).toBe('https://mcp.server1.com');
      expect(await resolvedHeaders(toolset)).toEqual({});
    });

    it('test_get_toolset_url_scheme', async () => {
      const registry = newRegistry();

      const cases: Array<[string, string]> = [
        ['test-mcp-server-http', 'http://mcp.server_http.com'],
        ['test-mcp-server-https', 'https://mcp.server_https.com'],
      ];
      for (const [serverName, expectedUrl] of cases) {
        const toolset = await registry.getToolset(serverName);
        expect(toolset.connectionParams.url).toBe(expectedUrl);
        expect(await resolvedHeaders(toolset)).toEqual({});
      }
    });

    it('test_get_toolset_credentials_only_for_google_api_url', async () => {
      const registry = newRegistry();

      const cases: Array<[string, Record<string, string>]> = [
        ['test-mcp-server-1', {}],
        ['test-mcp-server-http', {}],
        ['test-mcp-server-https', {}],
        ['test-mcp-server-google-http', {}],
        ['test-mcp-server-google', {Authorization: 'Bearer mock_token'}],
      ];
      for (const [serverName, expected] of cases) {
        const toolset = await registry.getToolset(serverName);
        expect(await resolvedHeaders(toolset)).toEqual(expected);
      }
    });

    it('test_get_toolset_server_not_found', async () => {
      const registry = newRegistry();

      await expect(registry.getToolset('non-existent-server')).rejects.toThrow(
        'MCP server non-existent-server not found in API Registry.',
      );
    });

    it('test_get_toolset_server_no_url', async () => {
      const registry = newRegistry();

      await expect(
        registry.getToolset('test-mcp-server-no-url'),
      ).rejects.toThrow('MCP server test-mcp-server-no-url has no URLs.');
    });

    it('test_init_configures_mtls', async () => {
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      vi.mocked(clientCertsToPresent).mockResolvedValue({
        cert: 'cert-pem',
        key: 'key-pem',
      });
      vi.mocked(getWithClientCert).mockResolvedValue({
        status: 200,
        body: JSON.stringify(MOCK_MCP_SERVERS_LIST),
      });

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(getWithClientCert).toHaveBeenCalledTimes(1);
      expect(getWithClientCert).toHaveBeenCalledWith(
        `${MTLS_LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
        {cert: 'cert-pem', key: 'key-pem'},
        60_000,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('adk-js only', () => {
    it('rejects an empty projectId', () => {
      expect(() => new ApiRegistry({projectId: ''})).toThrow(
        'projectId must be provided',
      );
    });

    it('defaults the location to global', async () => {
      const registry = new ApiRegistry({projectId: PROJECT_ID});
      await registry.getToolset('test-mcp-server-1');

      expect(registry.location).toBe('global');
      expect(fetchMock).toHaveBeenCalledWith(
        `${LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
      );
    });

    it('skips a listed server that carries no name', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        jsonResponse({
          mcpServers: [
            {urls: ['mcp.nameless.com']},
            {name: 'test-mcp-server-1', urls: ['mcp.server1.com']},
          ],
        }),
      );

      const registry = newRegistry();

      const toolset = await registry.getToolset('test-mcp-server-1');
      expect(toolset.connectionParams.url).toBe('https://mcp.server1.com');
      await expect(registry.getToolset('')).rejects.toThrow(
        'not found in API Registry',
      );
    });

    it('indexes nothing when a page carries no mcpServers field', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({}));

      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'not found in API Registry',
      );
    });

    it('keeps the later entry when a name repeats across pages', async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            mcpServers: [{name: 'test-mcp-server-1', urls: ['mcp.first.com']}],
            nextPageToken: 'next_page_token',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            mcpServers: [{name: 'test-mcp-server-1', urls: ['mcp.second.com']}],
          }),
        );

      const registry = newRegistry();

      const toolset = await registry.getToolset('test-mcp-server-1');
      expect(toolset.connectionParams.url).toBe('https://mcp.second.com');
    });

    it('merges the caller headerProvider over the resolved credentials', async () => {
      const registry = newRegistry({
        headerProvider: () => ({
          'X-Caller': 'yes',
          'Authorization': 'Bearer caller',
        }),
      });

      // A Google API host, so credentials are resolved and then overridden.
      const toolset = await registry.getToolset('test-mcp-server-google');

      expect(await resolvedHeaders(toolset)).toEqual({
        'Authorization': 'Bearer caller',
        'X-Caller': 'yes',
      });
    });

    it('supplies the caller headerProvider to a server that gets no credentials', async () => {
      const registry = newRegistry({
        headerProvider: () => ({'X-Caller': 'yes'}),
      });

      const toolset = await registry.getToolset('test-mcp-server-1');

      expect(await resolvedHeaders(toolset)).toEqual({'X-Caller': 'yes'});
    });

    it('reports a credential failure unwrapped', async () => {
      authState.failure = new Error('ADC unavailable');
      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'ADC unavailable',
      );
      await expect(
        registry.getToolset('test-mcp-server-1'),
      ).rejects.not.toThrow('Error fetching MCP servers');
    });

    it('rejects a non-2xx listing status whose body still parses', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        jsonResponse({error: {message: 'permission denied'}}, 403),
      );

      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry',
      );
      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'returned status 403',
      );
    });

    it('wraps a listing body that is not JSON', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response('<html>nope</html>', {status: 200}),
      );

      const registry = newRegistry();

      await expect(registry.getToolset('test-mcp-server-1')).rejects.toThrow(
        'Error fetching MCP servers from API Registry',
      );
    });

    it('selects the mTLS host under always, with no certificate', async () => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(fetchMock).toHaveBeenCalledWith(
        `${MTLS_LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
      );
    });

    it('reads an unrecognised GOOGLE_API_USE_MTLS_ENDPOINT as auto', async () => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'nonsense');
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      vi.mocked(clientCertsToPresent).mockResolvedValue({
        cert: 'cert-pem',
        key: 'key-pem',
      });
      vi.mocked(getWithClientCert).mockResolvedValue({
        status: 200,
        body: JSON.stringify(MOCK_MCP_SERVERS_LIST),
      });

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      // auto with a certificate available selects the mTLS host.
      expect(getWithClientCert).toHaveBeenCalledWith(
        `${MTLS_LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('stays on the default host under never, even with a certificate', async () => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      vi.mocked(clientCertsToPresent).mockResolvedValue({
        cert: 'cert-pem',
        key: 'key-pem',
      });
      vi.mocked(getWithClientCert).mockResolvedValue({
        status: 200,
        body: JSON.stringify(MOCK_MCP_SERVERS_LIST),
      });

      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(getWithClientCert).toHaveBeenCalledWith(
        `${LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('lists over plain fetch when no certificate is available', async () => {
      const registry = newRegistry();
      await registry.getToolset('test-mcp-server-1');

      expect(getWithClientCert).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        `${LIST_URL}?filter=enabled%3Dfalse`,
        expect.anything(),
      );
    });

    it('lists the registry once, however many toolsets are requested', async () => {
      const registry = newRegistry();

      await registry.getToolset('test-mcp-server-1');
      await registry.getToolset('test-mcp-server-2');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('omits the Authorization header when the credentials carry no token', async () => {
      authState.token = undefined;
      const registry = newRegistry();

      // A Google API host, so the gate lets credentials through and the empty
      // result is the missing token rather than the gate.
      const toolset = await registry.getToolset('test-mcp-server-google');

      expect(await resolvedHeaders(toolset)).toEqual({});
    });
  });
});
