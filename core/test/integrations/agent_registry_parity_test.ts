/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python
 * `tests/unittests/integrations/agent_registry/test_agent_registry.py` at
 * `main` `44e0b2a8b1215aa98f057c4a781ddc24bae220da`.
 *
 * Every `it()` keeps its Python function name so a reviewer can grep for the
 * original. `test_use_client_cert_effective` and `test_should_use_mtls_endpoint`
 * are ported to `core/test/utils/mtls_utils_test.ts`, where their functions
 * live.
 */

import {
  AgentRegistry,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  GcpAuthProviderScheme,
  ProtocolType,
  ReadonlyContext,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let quotaProjectId: string | undefined;
let getClientError: Error | undefined;
let getRequestHeadersError: Error | undefined;

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: async () => {
      if (getClientError) {
        throw getClientError;
      }
      return {
        getRequestHeaders: async () => {
          if (getRequestHeadersError) {
            throw getRequestHeadersError;
          }
          return {'Authorization': 'Bearer token'};
        },
        quotaProjectId,
      };
    },
    get quotaProjectId() {
      return quotaProjectId;
    },
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({tools: []}),
  })),
}));

const fetchMock = vi.fn<typeof fetch>();

/** Narrows an auth scheme to the GCP auth provider scheme, without a cast. */
function isGcpAuthProviderScheme(
  scheme: unknown,
): scheme is GcpAuthProviderScheme {
  return (
    typeof scheme === 'object' &&
    scheme !== null &&
    'type' in scheme &&
    scheme.type === 'gcpAuthProviderScheme'
  );
}

/** Returns the scheme as a GCP auth provider scheme, or fails the test. */
function gcpSchemeOf(scheme: AuthScheme | undefined): GcpAuthProviderScheme {
  if (!isGcpAuthProviderScheme(scheme)) {
    return expect.fail(`expected a GCP auth provider scheme, got ${scheme}`);
  }
  return scheme;
}

/** Returns the registry path a request URL addresses. */
function pathOf(url: string): string {
  return new URL(url).pathname.replace(
    /^\/v1alpha\/projects\/[^/]+\/locations\/[^/]+\//,
    '',
  );
}

/** Answers each registry path from `routes`; an unrouted path gets `{}`. */
function routeFetch(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation((input) => {
    const path = pathOf(String(input));
    const body = Object.prototype.hasOwnProperty.call(routes, path)
      ? routes[path]
      : {};
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
  });
}

/** The single fetch call the test made. */
function onlyCall() {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [input, init] = fetchMock.mock.calls[0];
  return {url: String(input), init};
}

/** The headers of the request at `index`, keyed by lowercase name. */
function headersOfCall(index: number): Record<string, string> {
  const headers = fetchMock.mock.calls[index][1]?.headers ?? {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
}

/** Registry metadata for an MCP server bound to an auth provider. */
const MCP_WITH_BINDING = {
  'test-mcp': {
    displayName: 'TestPrefix',
    mcpServerId: 'server-456',
    interfaces: [{url: 'https://mcp.com', protocolBinding: 'JSONRPC'}],
  },
  'bindings': {
    bindings: [
      {
        target: {
          identifier:
            'urn:mcp:projects-123:projects:123:locations:l:mcpServers:server-456',
        },
        authProviderBinding: {
          authProvider: 'projects/123/locations/l/authProviders/ap-789',
        },
      },
    ],
  },
};

/** Registry metadata for an A2A agent, before any binding is declared. */
const A2A_AGENT_INFO = {
  displayName: 'TestAgent',
  description: 'Test Desc',
  version: '1.0',
  protocols: [
    {
      type: ProtocolType.A2A_AGENT,
      interfaces: [{url: 'https://my-agent.com', protocolBinding: 'HTTP_JSON'}],
    },
  ],
};

/** Registry metadata for an A2A agent bound to an auth provider. */
const AGENT_WITH_BINDING = {
  'test-agent': {...A2A_AGENT_INFO, agentId: 'urn:agent:pub:ns:agent-456'},
  'bindings': {
    bindings: [
      {
        target: {identifier: 'urn:agent:pub:ns:agent-456'},
        authProviderBinding: {
          authProvider: 'projects/123/locations/l/authProviders/ap-789',
        },
      },
    ],
  },
};

/** The registry paths every request of the test addressed. */
function requestedPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => pathOf(String(input)));
}

function newRegistry(
  headerProvider?: (context: ReadonlyContext) => Record<string, string>,
): AgentRegistry {
  return new AgentRegistry({
    projectId: 'test-project',
    location: 'global',
    headerProvider,
  });
}

describe('TestAgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    quotaProjectId = undefined;
    getClientError = undefined;
    getRequestHeadersError = undefined;
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
    registry = newRegistry();
  });

  it('test_init_raises_value_error_if_params_missing', () => {
    expect(() => new AgentRegistry({location: 'global'})).toThrow(
      'project_id and location must be provided',
    );
    expect(() => new AgentRegistry({projectId: 'p'})).toThrow(
      'project_id and location must be provided',
    );
  });

  it('test_list_agents', async () => {
    routeFetch({agents: {agents: []}});
    await expect(registry.listAgents()).resolves.toEqual({agents: []});
    expect(onlyCall().init?.method).toBe('GET');
  });

  it('test_search_agents', async () => {
    routeFetch({'agents:search': {agents: [{name: 'agent-1'}]}});

    const agents = await registry.searchAgents({
      searchString: 'test-agent',
      searchType: 'KEYWORD',
      filterStr: 'display_name:test',
      orderBy: 'name',
      pageSize: 10,
      pageToken: 'next-token',
    });

    expect(agents).toEqual({agents: [{name: 'agent-1'}]});
    const {url, init} = onlyCall();
    expect(url).toBe(
      'https://agentregistry.googleapis.com/v1alpha/projects/test-project/locations/global/agents:search',
    );
    expect(init?.method).toBe('POST');
    expect(headersOfCall(0)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      searchString: 'test-agent',
      searchType: 'KEYWORD',
      filter: 'display_name:test',
      orderBy: 'name',
      pageSize: 10,
      pageToken: 'next-token',
    });
  });

  it('test_search_mcp_servers', async () => {
    routeFetch({'mcpServers:search': {mcpServers: [{name: 'mcp-1'}]}});

    const mcpServers = await registry.searchMcpServers({
      searchString: 'test-mcp',
      searchType: 'KEYWORD',
      filterStr: 'display_name:test',
      orderBy: 'name',
      pageSize: 10,
      pageToken: 'next-token',
    });

    expect(mcpServers).toEqual({mcpServers: [{name: 'mcp-1'}]});
    const {url, init} = onlyCall();
    expect(url).toBe(
      'https://agentregistry.googleapis.com/v1alpha/projects/test-project/locations/global/mcpServers:search',
    );
    expect(init?.method).toBe('POST');
    expect(headersOfCall(0)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      searchString: 'test-mcp',
      searchType: 'KEYWORD',
      filter: 'display_name:test',
      orderBy: 'name',
      pageSize: 10,
      pageToken: 'next-token',
    });
  });

  it('searchAgents with no options sends an empty body', async () => {
    routeFetch({'agents:search': {agents: []}});

    await registry.searchAgents();

    const {init} = onlyCall();
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it('test_get_mcp_server', async () => {
    routeFetch({'test-mcp': {name: 'test-mcp'}});
    await expect(registry.getMcpServer('test-mcp')).resolves.toEqual({
      name: 'test-mcp',
    });
  });

  it('test_get_auth_headers', async () => {
    const headers = await registry.getAuthHeaders();
    expect(headers['Authorization']).toBe('Bearer token');
    expect(headers).not.toHaveProperty('x-goog-user-project');
  });

  it('getAuthHeaders names an ADC discovery failure', async () => {
    getClientError = new Error('Could not load the default credentials');
    await expect(registry.getAuthHeaders()).rejects.toThrow(
      'Failed to get default Google Cloud credentials: Could not load the default credentials',
    );
  });

  it('getAuthHeaders names a token refresh failure separately', async () => {
    getRequestHeadersError = new Error('invalid_grant');
    await expect(registry.getAuthHeaders()).rejects.toThrow(
      'Failed to refresh Google Cloud credentials: invalid_grant',
    );
  });

  it('test_registry_requests_identify_adk', async () => {
    routeFetch({'mcpServers:search': {mcpServers: []}});

    await registry.searchMcpServers({searchString: 'test'});

    const headers = headersOfCall(0);
    expect(headers['x-goog-api-client']).toContain('google-adk/');
    expect(headers['user-agent']).toContain('google-adk/');
  });

  it('makeRequest falls back to the configured project for the quota project', async () => {
    routeFetch({agents: {agents: []}});

    await registry.listAgents();

    expect(headersOfCall(0)['x-goog-user-project']).toBe('test-project');
  });

  it('makeRequest prefers the credential quota project', async () => {
    quotaProjectId = 'quota-project';
    routeFetch({agents: {agents: []}});

    await registry.listAgents();

    expect(headersOfCall(0)['x-goog-user-project']).toBe('quota-project');
  });

  describe('test_get_mcp_toolset_auth_headers', () => {
    const cases: Array<{
      url: string;
      expectedAuth: boolean;
      useCustomProvider: boolean;
    }> = [
      {url: 'https://mcp.com', expectedAuth: false, useCustomProvider: false},
      {
        url: 'https://mcp.googleapis.com/v1',
        expectedAuth: true,
        useCustomProvider: false,
      },
      {
        url: 'https://example.com/googleapis/v1',
        expectedAuth: false,
        useCustomProvider: false,
      },
      {
        url: 'http://mcp.googleapis.com/v1',
        expectedAuth: false,
        useCustomProvider: false,
      },
      {
        url: 'https://mcp.googleapis.com/v1',
        expectedAuth: true,
        useCustomProvider: true,
      },
    ];

    for (const {url, expectedAuth, useCustomProvider} of cases) {
      it(`${url} auth=${expectedAuth} customProvider=${useCustomProvider}`, async () => {
        routeFetch({
          'test-mcp': {
            displayName: 'TestPrefix',
            interfaces: [{url, protocolBinding: 'JSONRPC'}],
          },
        });
        const subject = useCustomProvider
          ? newRegistry(() => ({'Authorization': 'Bearer custom_token'}))
          : registry;

        const toolset = await subject.getMcpToolset('test-mcp');
        const headers = await toolset.headerProvider?.({} as ReadonlyContext);

        if (useCustomProvider) {
          expect(headers?.['Authorization']).toBe('Bearer custom_token');
        } else if (expectedAuth) {
          expect(headers?.['Authorization']).toBe('Bearer token');
        } else {
          expect(headers).not.toHaveProperty('Authorization');
        }
      });
    }
  });

  it('test_get_mcp_toolset_with_binding', async () => {
    routeFetch(MCP_WITH_BINDING);

    const toolset = await registry.getMcpToolset('test-mcp', {
      continueUri: 'https://override.com/continue',
    });

    const scheme = gcpSchemeOf(toolset.authScheme);
    expect(scheme.name).toBe('projects/123/locations/l/authProviders/ap-789');
    expect(scheme.continueUri).toBe('https://override.com/continue');
  });

  it('getMcpToolset leaves the server unauthenticated when no binding matches', async () => {
    routeFetch({...MCP_WITH_BINDING, bindings: {bindings: []}});

    const toolset = await registry.getMcpToolset('test-mcp');

    expect(toolset.authScheme).toBeUndefined();
  });

  it('getMcpToolset tolerates a bindings failure', async () => {
    routeFetch({
      ...MCP_WITH_BINDING,
      bindings: new Error('bindings unavailable'),
    });

    const toolset = await registry.getMcpToolset('test-mcp');

    expect(toolset.authScheme).toBeUndefined();
  });

  it('test_get_remote_a2a_agent_with_binding', async () => {
    routeFetch(AGENT_WITH_BINDING);

    const agent = await registry.getRemoteA2AAgent('test-agent', {
      continueUri: 'https://override.com/continue',
    });

    const scheme = gcpSchemeOf(agent.authScheme);
    expect(scheme.name).toBe('projects/123/locations/l/authProviders/ap-789');
    expect(scheme.continueUri).toBe('https://override.com/continue');
  });

  it('test_get_remote_a2a_agent_with_card_and_binding', async () => {
    routeFetch({
      ...AGENT_WITH_BINDING,
      'test-agent': {
        agentId: 'urn:agent:pub:ns:agent-456',
        card: {
          type: 'A2A_AGENT_CARD',
          content: {
            name: 'CardName',
            description: 'CardDesc',
            version: '2.0',
            url: 'https://card-agent.com',
            capabilities: {},
            defaultInputModes: ['text'],
            defaultOutputModes: ['text'],
            skills: [],
          },
        },
      },
    });

    const agent = await registry.getRemoteA2AAgent('test-agent');

    expect(gcpSchemeOf(agent.authScheme).name).toBe(
      'projects/123/locations/l/authProviders/ap-789',
    );
  });

  it('test_get_remote_a2a_agent_with_explicit_auth', async () => {
    routeFetch(AGENT_WITH_BINDING);
    const authScheme: GcpAuthProviderScheme = {
      type: 'gcpAuthProviderScheme',
      name: 'explicit-provider',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key',
    };

    const agent = await registry.getRemoteA2AAgent('test-agent', {
      authScheme,
      authCredential,
    });

    expect(agent.authScheme).toBe(authScheme);
    expect(agent.authCredential).toBe(authCredential);
    expect(requestedPaths()).not.toContain('bindings');
  });

  it('test_get_remote_a2a_agent_without_binding', async () => {
    routeFetch({...AGENT_WITH_BINDING, bindings: {bindings: []}});

    const agent = await registry.getRemoteA2AAgent('test-agent');

    expect(agent.authScheme).toBeUndefined();
    expect(agent.authCredential).toBeUndefined();
  });

  it('test_get_remote_a2a_agent_tolerates_bindings_failure', async () => {
    routeFetch({
      ...AGENT_WITH_BINDING,
      bindings: new Error('bindings unavailable'),
    });

    const agent = await registry.getRemoteA2AAgent('test-agent');

    expect(agent.authScheme).toBeUndefined();
  });

  it('getRemoteA2AAgent skips the binding lookup for an agent with no id', async () => {
    routeFetch({...AGENT_WITH_BINDING, 'test-agent': A2A_AGENT_INFO});

    const agent = await registry.getRemoteA2AAgent('test-agent');

    expect(agent.authScheme).toBeUndefined();
    expect(requestedPaths()).not.toContain('bindings');
  });

  it('test_make_request_raises_http_status_error', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', {status: 500}),
    );
    await expect(registry.makeRequest('test-path')).rejects.toThrow(
      'API request failed with status 500: Internal Server Error',
    );
  });

  it('test_make_request_error_handling', async () => {
    fetchMock.mockRejectedValue(new Error('Connection error'));
    await expect(registry.makeRequest('test-path')).rejects.toThrow(
      'API request failed: Connection error',
    );
  });
});

describe('TestAgentRegistryMtls', () => {
  const originalClientCert = process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];

  beforeEach(() => {
    quotaProjectId = undefined;
    getClientError = undefined;
    getRequestHeadersError = undefined;
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    if (originalClientCert === undefined) {
      delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    } else {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = originalClientCert;
    }
  });

  it('test_make_request_uses_authorized_session_no_mtls', async () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    const registry = newRegistry();
    routeFetch({'test-path': {key: 'value'}});

    await expect(registry.makeRequest('test-path')).resolves.toEqual({
      key: 'value',
    });
    expect(onlyCall().url).toContain('agentregistry.googleapis.com');
    expect(onlyCall().url).not.toContain('mtls');
  });

  it('test_make_request_configures_mtls', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    const registry = newRegistry();
    routeFetch({'test-path': {key: 'value'}});

    await registry.makeRequest('test-path');

    expect(onlyCall().url).toContain('agentregistry.mtls.googleapis.com');
  });

  it('getConnectionUri rewrites a resolved endpoint to its mTLS host', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    const registry = newRegistry();

    const {url} = registry.getConnectionUri({
      interfaces: [{url: 'https://mcp.googleapis.com/v1'}],
    });

    expect(url).toBe('https://mcp.mtls.googleapis.com/v1');
  });

  it('getConnectionUri leaves a resolved endpoint alone without mTLS', () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    const registry = newRegistry();

    const {url} = registry.getConnectionUri({
      interfaces: [{url: 'https://mcp.googleapis.com/v1'}],
    });

    expect(url).toBe('https://mcp.googleapis.com/v1');
  });
});
