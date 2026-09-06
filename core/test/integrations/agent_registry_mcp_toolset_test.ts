/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  AgentRegistrySingleMCPToolset,
  AuthCredential,
  AuthCredentialTypes,
  BaseAuthProvider,
  createSession,
  GCP_MCP_SERVER_DESTINATION_ID,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  registerAuthProvider,
} from '../../src/index.js';
import {StreamableHTTPConnectionParams} from '../../src/tools/mcp/mcp_session_manager.js';
import {logger} from '../../src/utils/logger.js';

const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {name: 'search', description: 'Search the web', inputSchema: {}},
    {name: 'fetch', description: 'Fetch a URL', inputSchema: {}},
  ],
});

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

const BASE_PARAMS: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.com/mcp',
};

/**
 * An auth provider that mints one fixed bearer token. `getAuthCredential` is a
 * spy so the config the toolset builds can be asserted.
 *
 * `registerAuthProvider` writes to a process-wide registry, so each test
 * registers its own scheme type rather than resetting shared state.
 */
class StaticTokenProvider implements BaseAuthProvider {
  readonly getAuthCredential: Mock<BaseAuthProvider['getAuthCredential']>;

  constructor(
    readonly supportedAuthSchemes: readonly string[],
    token: string,
  ) {
    this.getAuthCredential = vi
      .fn<BaseAuthProvider['getAuthCredential']>()
      .mockResolvedValue({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Bearer', credentials: {token}},
      });
  }
}

function makeContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'sess-1', appName: 'app', userId: 'user-1'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('AgentRegistrySingleMCPToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({
      tools: [
        {name: 'search', description: 'Search the web', inputSchema: {}},
        {name: 'fetch', description: 'Fetch a URL', inputSchema: {}},
      ],
    });
  });

  describe('getTools — tool name prefixing', () => {
    it('returns tools with unprefixed names when no prefix is set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toEqual(['search', 'fetch']);
    });

    it('prefixes tool names with the configured prefix', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        prefix: 'my_server',
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toEqual([
        'my_server_search',
        'my_server_fetch',
      ]);
    });
  });

  describe('getTools — destinationResourceId injection', () => {
    it('injects GCP_MCP_SERVER_DESTINATION_ID into each tool when set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        destinationResourceId: 'projects/p/locations/l/mcpServers/s',
      });
      const tools = await toolset.getTools();
      for (const tool of tools) {
        const meta = (
          tool as unknown as {customMetadata?: Record<string, string>}
        ).customMetadata;
        expect(meta?.[GCP_MCP_SERVER_DESTINATION_ID]).toBe(
          'projects/p/locations/l/mcpServers/s',
        );
      }
    });

    it('does not add customMetadata when destinationResourceId is not set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      const tools = await toolset.getTools();
      for (const tool of tools) {
        const meta = (
          tool as unknown as {customMetadata?: Record<string, string>}
        ).customMetadata;
        expect(meta?.[GCP_MCP_SERVER_DESTINATION_ID]).toBeUndefined();
      }
    });
  });

  describe('getTools — toolFilter', () => {
    it('returns all tools when toolFilter is an empty array', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: [],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(2);
    });

    it('filters tools by name when toolFilter is a string array', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: ['search'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search');
    });

    it('filters by prefixed name when prefix and toolFilter are both set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        prefix: 'srv',
        toolFilter: ['srv_search'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('srv_search');
    });

    it('returns an empty list when no tool name matches the filter', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: ['nonexistent'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(0);
    });
  });

  describe('getTools — headerProvider', () => {
    it('calls headerProvider and merges returned headers into requestInit', async () => {
      const headerProvider = vi
        .fn()
        .mockResolvedValue({'Authorization': 'Bearer token'});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider,
      });
      await toolset.getTools();
      expect(headerProvider).toHaveBeenCalledOnce();
    });

    it('merges headerProvider headers over existing transportOptions headers', async () => {
      const Transport = (
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      ).StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>;

      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: {
          ...BASE_PARAMS,
          transportOptions: {
            requestInit: {
              headers: {'X-Existing': 'yes'} as Record<string, string>,
            },
          },
        },
        headerProvider: async () => ({'Authorization': 'Bearer new'}),
      });

      await toolset.getTools();

      const constructorArg = Transport.mock.calls.at(-1)?.[1];
      expect(constructorArg?.requestInit?.headers).toMatchObject({
        'X-Existing': 'yes',
        'Authorization': 'Bearer new',
      });
    });

    it('passes context to headerProvider when one is provided', async () => {
      const headerProvider = vi.fn().mockResolvedValue({});
      const context = {} as never;
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider,
      });
      await toolset.getTools(context);
      expect(headerProvider).toHaveBeenCalledWith(context);
    });
  });

  describe('getTools — session cleanup', () => {
    it('closes the discovery session after listing tools', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await toolset.getTools();

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('closes the discovery session when listing tools fails', async () => {
      mockListTools.mockRejectedValueOnce(new Error('discovery failed'));
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await expect(toolset.getTools()).rejects.toThrow('discovery failed');
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('preserves the discovery error when closing also fails', async () => {
      mockListTools.mockRejectedValueOnce(new Error('discovery failed'));
      mockClose.mockRejectedValueOnce(new Error('close failed'));
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await expect(toolset.getTools()).rejects.toThrow('discovery failed');
      expect(mockClose).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to close MCP discovery session',
        expect.objectContaining({message: 'close failed'}),
      );
      warnSpy.mockRestore();
    });
  });

  describe('close', () => {
    it('resolves without throwing', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });

  describe('getTools — custom auth scheme resolution', () => {
    async function transportHeaders() {
      const Transport = vi.mocked(
        (await import('@modelcontextprotocol/sdk/client/streamableHttp.js'))
          .StreamableHTTPClientTransport,
      );
      return Transport.mock.calls.at(-1)?.[1]?.requestInit?.headers;
    }

    it('sends the resolved credential as an Authorization header', async () => {
      registerAuthProvider(
        new StaticTokenProvider(['mcpBearerScheme'], 'tok-bearer'),
      );
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpBearerScheme'},
      });

      await toolset.getTools();

      expect(await transportHeaders()).toMatchObject({
        'Authorization': 'Bearer tok-bearer',
      });
    });

    it('lets the credential header win over the headerProvider header', async () => {
      registerAuthProvider(
        new StaticTokenProvider(['mcpPrecedenceScheme'], 'tok-credential'),
      );
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpPrecedenceScheme'},
        headerProvider: async () => ({
          'Authorization': 'Bearer tok-header-provider',
          'X-Trace': 'keep-me',
        }),
      });

      await toolset.getTools();

      expect(await transportHeaders()).toMatchObject({
        'Authorization': 'Bearer tok-credential',
        'X-Trace': 'keep-me',
      });
    });

    it('warns and sends no Authorization header when no provider is registered', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpUnregisteredScheme'},
      });

      const tools = await toolset.getTools();

      expect(tools.map((t) => t.name)).toEqual(['search', 'fetch']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mcpUnregisteredScheme'),
      );
      expect(await transportHeaders()).not.toHaveProperty('Authorization');
      warnSpy.mockRestore();
    });

    it('warns and sends no Authorization header when the provider throws', async () => {
      const provider = new StaticTokenProvider(['mcpFailingScheme'], 'unused');
      provider.getAuthCredential.mockRejectedValue(new Error('minting failed'));
      registerAuthProvider(provider);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpFailingScheme'},
      });

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('minting failed'),
      );
      expect(await transportHeaders()).not.toHaveProperty('Authorization');
      warnSpy.mockRestore();
    });

    it('warns with the stringified value when the provider rejects a non-Error', async () => {
      const provider = new StaticTokenProvider(
        ['mcpRejectRawScheme'],
        'unused',
      );
      provider.getAuthCredential.mockRejectedValue('token endpoint is down');
      registerAuthProvider(provider);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpRejectRawScheme'},
      });

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('token endpoint is down'),
      );
      warnSpy.mockRestore();
    });

    it('does not consult a provider for an OpenAPI auth scheme', async () => {
      const provider = new StaticTokenProvider(['http'], 'tok-should-not-run');
      registerAuthProvider(provider);
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'http', scheme: 'bearer'},
      });

      await toolset.getTools();

      expect(provider.getAuthCredential).not.toHaveBeenCalled();
      expect(await transportHeaders()).not.toHaveProperty('Authorization');
    });

    it('sends only the headerProvider headers when no authScheme is set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider: async () => ({'X-Only': 'yes'}),
      });

      await toolset.getTools();

      expect(await transportHeaders()).toEqual({'X-Only': 'yes'});
    });

    it('derives the credential key from the destination resource id', async () => {
      const provider = new StaticTokenProvider(['mcpKeyScheme'], 'tok-key');
      registerAuthProvider(provider);
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        destinationResourceId: 'projects/p/locations/l/mcpServers/s',
        authScheme: {type: 'mcpKeyScheme'},
      });

      await toolset.getTools();

      expect(provider.getAuthCredential).toHaveBeenCalledWith(
        {
          authScheme: {type: 'mcpKeyScheme'},
          rawAuthCredential: undefined,
          credentialKey: 'mcpKeyScheme_projects/p/locations/l/mcpServers/s',
        },
        undefined,
      );
    });

    it('forwards the raw credential and the context to the provider', async () => {
      const provider = new StaticTokenProvider(['mcpForwardScheme'], 'tok-fwd');
      registerAuthProvider(provider);
      const rawAuthCredential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'raw-key',
      };
      const context = makeContext();
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        prefix: 'srv',
        authScheme: {type: 'mcpForwardScheme'},
        authCredential: rawAuthCredential,
      });

      await toolset.getTools(context);

      expect(provider.getAuthCredential).toHaveBeenCalledWith(
        {
          authScheme: {type: 'mcpForwardScheme'},
          rawAuthCredential,
          credentialKey: 'mcpForwardScheme_srv',
        },
        context,
      );
    });

    it('falls back to a default credential key with no resource id or prefix', async () => {
      const provider = new StaticTokenProvider(
        ['mcpDefaultKeyScheme'],
        'tok-default',
      );
      registerAuthProvider(provider);
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: {type: 'mcpDefaultKeyScheme'},
      });

      await toolset.getTools();

      expect(provider.getAuthCredential).toHaveBeenCalledWith(
        expect.objectContaining({credentialKey: 'mcpDefaultKeyScheme_default'}),
        undefined,
      );
    });
  });
});
