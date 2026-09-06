/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseAgent} from '../../../src/agents/base_agent.js';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {
  MCPHeaderProvider,
  MCPToolset,
  MCPToolsetOptions,
} from '../../../src/tools/mcp/mcp_toolset.js';
import {logger} from '../../../src/utils/logger.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {name: 'test-tool', description: 'A test tool', inputSchema: {}},
          {name: 'other-tool', description: 'Another tool', inputSchema: {}},
        ],
      }),
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {uri: 'file:///res1', name: 'res1'},
          {uri: 'file:///res2', name: 'res2'},
        ],
      }),
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello'},
        ],
      }),
      callTool: vi.fn().mockResolvedValue({content: []}),
    })),
  };
});

/** A client method stub that resolves to nothing (connect/close). */
const noop = () => vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  };
});

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

const httpParams: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://test-url',
  transportOptions: {requestInit: {headers: {'X-Static': 'yes'}}},
};

/**
 * The headers of one set of transport options, as a record. `Headers`
 * lower-cases every name it stores, which is the spelling the wire uses.
 */
function headersOf(
  options?: StreamableHTTPClientTransportOptions,
): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(options?.requestInit?.headers).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-tool');
    expect(tools[1].name).toBe('other-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('myprefix_test-tool');
    expect(tools[1].name).toBe('myprefix_other-tool');
  });

  describe('toolFilter', () => {
    it('empty array (default) returns all tools', async () => {
      const toolset = new MCPToolset(stdioParams, []);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('string array filter returns only matching tools', async () => {
      const toolset = new MCPToolset(stdioParams, ['test-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
    });

    it('string array filter with prefix matches prefixed names', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        ['myprefix_test-tool'],
        'myprefix',
      );
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('myprefix_test-tool');
    });

    it('string array filter returns empty when no tools match', async () => {
      const toolset = new MCPToolset(stdioParams, ['nonexistent-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(0);
    });

    it('predicate filter applies when context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      const tools = await toolset.getTools({} as ReadonlyContext);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('other-tool');
    });

    it('predicate filter returns all tools when no context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      // No context passed — filter cannot be applied, returns all tools
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });
  });

  describe('headerProvider', () => {
    /** Options handed to the most recently constructed HTTP transport. */
    const lastTransportOptions = () =>
      vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1];

    beforeEach(() => {
      vi.mocked(StreamableHTTPClientTransport).mockClear();
      vi.mocked(StdioClientTransport).mockClear();
      vi.mocked(Client).mockClear();
    });

    it('no headerProvider leaves transport options unchanged', async () => {
      const toolset = new MCPToolset(httpParams);

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'X-Static': 'yes'}},
      });
    });

    it('invokes the provider once per getTools() call and uses the fresh value', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementationOnce(async () => ({Authorization: 'Bearer t1'}))
        .mockImplementationOnce(async () => ({Authorization: 'Bearer t2'}));
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: provider,
      });

      await toolset.getTools();
      const firstOptions = lastTransportOptions();
      await toolset.getTools();

      expect(provider).toHaveBeenCalledTimes(2);
      expect(headersOf(firstOptions)).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer t1',
      });
      expect(headersOf(lastTransportOptions())).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer t2',
      });
    });

    it('merges provider headers over static transportOptions headers', async () => {
      const params: MCPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            headers: {'X-Static': 'yes', Authorization: 'Bearer old'},
          },
        },
      };
      const toolset = new MCPToolset({
        connectionParams: params,
        headerProvider: async () => ({Authorization: 'Bearer new'}),
      });

      await toolset.getTools();

      expect(headersOf(lastTransportOptions())).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer new',
      });
    });

    it('passes the ReadonlyContext to the provider', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementation(async () => ({}));
      const context = {} as ReadonlyContext;
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: provider,
      });

      await toolset.getTools(context);

      expect(provider).toHaveBeenCalledWith(context);
    });

    it('calls the provider with undefined when getTools() has no context', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementation(async () => ({}));
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: provider,
      });

      await toolset.getTools();

      expect(provider).toHaveBeenCalledWith(undefined);
    });

    it('supports a synchronous provider', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({Authorization: 'Bearer sync'}),
      });

      await toolset.getTools();

      expect(headersOf(lastTransportOptions())).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer sync',
      });
    });

    it('an empty provider result leaves transport options unchanged', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({}),
      });

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'X-Static': 'yes'}},
      });
    });

    it('propagates a provider rejection and creates no session', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: async () => {
          throw new Error('token fetch failed');
        },
      });

      await expect(toolset.getTools()).rejects.toThrow('token fetch failed');
      expect(Client).not.toHaveBeenCalled();
      expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    });

    it('resolved headers are handed to the returned MCPTools', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({Authorization: 'Bearer call'}),
      });

      const tools = await toolset.getTools();
      const toolContext = new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          agent: {} as BaseAgent,
          session: createSession({id: 'session-1', appName: 'app'}),
          pluginManager: new PluginManager(),
          abortSignal: new AbortController().signal,
        }),
      });
      await tools[0].runAsync({args: {}, toolContext});

      // Two transports: the discovery session, then the tool-call session.
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
      expect(headersOf(lastTransportOptions())).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer call',
      });
    });

    it('works with a stdio transport', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        headerProvider: () => ({Authorization: 'Bearer ignored'}),
      });

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(StdioClientTransport).toHaveBeenCalledWith({command: 'test'});
    });
  });

  describe('cleanup', () => {
    it('closes the session and leaves activeSessions empty after getTools success', async () => {
      const toolset = new MCPToolset(stdioParams);
      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('closes the session and leaves activeSessions empty even if listTools throws an error', async () => {
      const toolset = new MCPToolset(stdioParams);

      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const mockClientInstance = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockRejectedValue(new Error('List tools failed')),
      };
      vi.mocked(Client).mockImplementationOnce(
        () => mockClientInstance as unknown as Client,
      );

      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      await expect(toolset.getTools()).rejects.toThrow('List tools failed');
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });
  });

  describe('resources', () => {
    it('listResources returns the mapped resource names', async () => {
      const toolset = new MCPToolset(stdioParams);

      const names = await toolset.listResources();

      expect(names).toEqual(['res1', 'res2']);
    });

    it('getResourceInfo returns the matching resource', async () => {
      const toolset = new MCPToolset(stdioParams);

      const info = await toolset.getResourceInfo('res1');

      expect(info.name).toBe('res1');
      expect(info.uri).toBe('file:///res1');
    });

    it('getResourceInfo rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getResourceInfo('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource resolves the URI and returns the contents', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const readResource = vi.fn().mockResolvedValue({
        contents: [{uri: 'file:///res1', text: 'hello'}],
      });
      vi.mocked(Client)
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockResolvedValue({
                resources: [{uri: 'file:///res1', name: 'res1'}],
              }),
            }) as unknown as Client,
        )
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              readResource,
            }) as unknown as Client,
        );

      const toolset = new MCPToolset(stdioParams);
      const contents = await toolset.readResource('res1');

      expect(readResource).toHaveBeenCalledWith({uri: 'file:///res1'});
      expect(contents).toEqual([{uri: 'file:///res1', text: 'hello'}]);
    });

    it('readResource rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource rejects when the resolved resource has no URI', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: '', name: 'res1'}],
            }),
          }) as unknown as Client,
      );

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('res1')).rejects.toThrow(
        "Resource 'res1' has no URI.",
      );
    });

    describe('cleanup', () => {
      it('closes the session after listResources succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.listResources();

        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes the session even if the client listResources rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client).mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockRejectedValue(new Error('list boom')),
            }) as unknown as Client,
        );

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.listResources()).rejects.toThrow('list boom');
        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions after readResource succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.readResource('res1');

        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions even if the client readResource rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client)
          .mockImplementationOnce(
            () =>
              ({
                connect: noop(),
                close: noop(),
                listResources: vi.fn().mockResolvedValue({
                  resources: [{uri: 'file:///res1', name: 'res1'}],
                }),
              }) as unknown as Client,
          )
          .mockImplementationOnce(
            () =>
              ({
                connect: noop(),
                close: noop(),
                readResource: vi.fn().mockRejectedValue(new Error('read boom')),
              }) as unknown as Client,
          );

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.readResource('res1')).rejects.toThrow('read boom');
        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });
    });
  });

  describe('options constructor', () => {
    it('discovers the same tools as the positional form', async () => {
      const toolset = new MCPToolset({connectionParams: stdioParams});

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'test-tool',
        'other-tool',
      ]);
    });

    it('applies the prefix and the tool filter it carries', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolFilter: ['srv_test-tool'],
        prefix: 'srv',
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['srv_test-tool']);
    });

    it('uses the header provider it carries', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({Authorization: 'Bearer from-options'}),
      });

      await toolset.getTools();

      expect(
        headersOf(
          vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1],
        ),
      ).toEqual({'x-static': 'yes', authorization: 'Bearer from-options'});
    });

    it('rejects options that carry no connection params', () => {
      // A configuration document read at runtime can omit the field that
      // TypeScript makes mandatory.
      const options = {prefix: 'srv'} as unknown as MCPToolsetOptions;

      expect(() => new MCPToolset(options)).toThrow(
        'Missing connection params in MCPToolset.',
      );
    });

    it('rejects a missing argument', () => {
      const options = null as unknown as MCPToolsetOptions;

      expect(() => new MCPToolset(options)).toThrow(
        'Missing connection params in MCPToolset.',
      );
    });
  });

  describe('authentication', () => {
    const apiKeyScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
    const oauth2Scheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {read: 'Read access'},
        },
      },
    };
    const oauth2Credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
    };

    /** Headers the most recently constructed HTTP transport was given. */
    const lastTransportHeaders = () =>
      headersOf(
        vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1],
      );

    /** Sets the exchanged credential the way ADK's auth flow would. */
    const setExchangedCredential = (
      toolset: MCPToolset,
      credential: AuthCredential,
    ) => {
      const authConfig = toolset.getAuthConfig();
      if (!authConfig) {
        expect.fail('an auth scheme was configured, so getAuthConfig is set');
      }
      authConfig.exchangedAuthCredential = credential;
    };

    const apiKeyCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };
    const accessTokenCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'exchanged-token'},
    };

    beforeEach(() => {
      vi.mocked(StreamableHTTPClientTransport).mockClear();
      vi.mocked(Client).mockClear();
    });

    it('getAuthConfig returns undefined without an auth scheme', () => {
      const toolset = new MCPToolset({connectionParams: httpParams});

      expect(toolset.getAuthConfig()).toBeUndefined();
    });

    it('getAuthConfig carries the scheme, the raw credential and the default key', () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: oauth2Scheme,
        authCredential: oauth2Credential,
      });

      expect(toolset.getAuthConfig()).toEqual({
        authScheme: oauth2Scheme,
        rawAuthCredential: oauth2Credential,
        credentialKey: 'default_mcp_key',
      });
    });

    it('getAuthConfig uses the credential key the caller named', () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: oauth2Scheme,
        credentialKey: 'my-mcp-key',
      });

      expect(toolset.getAuthConfig()?.credentialKey).toBe('my-mcp-key');
    });

    it('getAuthConfig returns the same instance on every call', () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: oauth2Scheme,
      });

      expect(toolset.getAuthConfig()).toBe(toolset.getAuthConfig());
    });

    it('sends no auth header before the credential is exchanged', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: oauth2Scheme,
        authCredential: oauth2Credential,
      });

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({'x-static': 'yes'});
    });

    it('sends the configured API key without an exchange step', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
        authCredential: apiKeyCredential,
      });

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-api-key': 'test-api-key',
      });
    });

    it('an exchanged credential replaces the configured one', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
        authCredential: apiKeyCredential,
      });
      setExchangedCredential(toolset, {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'exchanged-api-key',
      });

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-api-key': 'exchanged-api-key',
      });
    });

    it('replaces a provider header that differs only in case', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({authorization: 'Bearer from-provider'}),
        authScheme: oauth2Scheme,
      });
      setExchangedCredential(toolset, accessTokenCredential);

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer exchanged-token',
      });
    });

    it('sends the exchanged access token as a bearer header', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: oauth2Scheme,
        authCredential: oauth2Credential,
      });
      setExchangedCredential(toolset, accessTokenCredential);

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer exchanged-token',
      });
    });

    it('sends an API key in the header its scheme names', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
      });
      setExchangedCredential(toolset, apiKeyCredential);

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-api-key': 'test-api-key',
      });
    });

    it('an auth header wins over the header provider on a conflict', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: () => ({
          Authorization: 'Bearer from-provider',
          'X-Tenant': 'acme',
        }),
        authScheme: oauth2Scheme,
      });
      setExchangedCredential(toolset, accessTokenCredential);

      await toolset.getTools();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-tenant': 'acme',
        authorization: 'Bearer exchanged-token',
      });
    });

    it('the discovered tools carry the auth header into their calls', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
      });
      setExchangedCredential(toolset, apiKeyCredential);

      const tools = await toolset.getTools();
      const toolContext = new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-auth',
          agent: {} as BaseAgent,
          session: createSession({id: 'session-auth', appName: 'app'}),
          pluginManager: new PluginManager(),
          abortSignal: new AbortController().signal,
        }),
      });
      await tools[0].runAsync({args: {}, toolContext});

      // Two transports: the discovery session, then the tool-call session.
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-api-key': 'test-api-key',
      });
    });

    it('listResources sends the auth header', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
      });
      setExchangedCredential(toolset, apiKeyCredential);

      await toolset.listResources();

      expect(lastTransportHeaders()).toEqual({
        'x-static': 'yes',
        'x-api-key': 'test-api-key',
      });
    });

    it('readResource resolves the headers once', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementation(() => ({'X-Tenant': 'acme'}));
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        headerProvider: provider,
      });

      await toolset.readResource('res1');

      expect(provider).toHaveBeenCalledTimes(1);
    });

    it('readResource sends the auth header on both sessions', async () => {
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authScheme: apiKeyScheme,
      });
      setExchangedCredential(toolset, apiKeyCredential);

      await toolset.readResource('res1');

      // One session resolves the name, the second reads the resource.
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(StreamableHTTPClientTransport).mock.calls) {
        expect(headersOf(call[1])).toEqual({
          'x-static': 'yes',
          'x-api-key': 'test-api-key',
        });
      }
    });

    it('warns and sends no auth header for a credential with no scheme', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new MCPToolset({
        connectionParams: httpParams,
        authCredential: apiKeyCredential,
      });

      await toolset.getTools();

      expect(toolset.getAuthConfig()).toBeUndefined();
      expect(lastTransportHeaders()).toEqual({'x-static': 'yes'});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('authCredential was given without authScheme'),
      );
    });
  });
});
