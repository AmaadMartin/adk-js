/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  InvocationContext,
  MCPSessionManager,
  MCPTool,
  MCPToolAuthOptions,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

/**
 * The `test_*` cases below are ported from adk-python,
 * `tests/unittests/tools/mcp_tool/test_mcp_tool.py`, and keep their original
 * names so the two suites can be compared.
 */

const MCP_TOOL: Tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: {type: 'object', properties: {}},
};

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/o/oauth2/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {'read:tools': 'read'},
    },
  },
};

const BEARER_SCHEME: AuthScheme = {type: 'http', scheme: 'bearer'};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Custom-Key',
  in: 'header',
};

const BEARER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'static-token'}},
};

const GRANTED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'granted-token'}},
};

/** A session manager whose `createSession` records the headers it receives. */
function createSessionManager() {
  const client = {
    callTool: vi.fn().mockResolvedValue({content: []}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Client;

  return {
    client,
    manager: {
      createSession: vi.fn().mockResolvedValue(client),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager,
  };
}

/**
 * A real `Context` over `sessionState`, so a credential the handler caches is
 * observable through the same state the next call reads.
 */
function createToolContext(
  sessionState: Record<string, unknown> = {},
): Context {
  const invocationContext = {
    abortSignal: new AbortController().signal,
    session: {state: sessionState},
  } as unknown as InvocationContext;
  return new Context({invocationContext, functionCallId: 'function-call-1'});
}

function createTool(
  options: MCPToolAuthOptions,
  manager: MCPSessionManager,
): MCPTool {
  return new MCPTool(MCP_TOOL, manager, undefined, options);
}

describe('MCPTool authentication', () => {
  describe('ported from adk-python test_mcp_tool.py', () => {
    it('test_init_with_auth', async () => {
      const {manager} = createSessionManager();
      const tool = createTool(
        {authScheme: BEARER_SCHEME, authCredential: BEARER_CREDENTIAL},
        manager,
      );

      expect(tool.name).toBe('test-tool');
      expect(tool.description).toBe('A test tool');

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(manager.createSession).toHaveBeenCalledWith({
        Authorization: 'Bearer static-token',
      });
    });

    it('test_run_async_impl_no_auth', async () => {
      const {manager, client} = createSessionManager();
      const tool = new MCPTool(MCP_TOOL, manager);

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(manager.createSession).toHaveBeenCalledWith(undefined);
      expect(client.callTool).toHaveBeenCalled();
    });

    it('test_run_async_impl_with_oauth2', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext({
        'mcp_oauth2_existing_exchanged_credential': {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'exchanged-token'},
        },
      });
      const tool = createTool({authScheme: OAUTH2_SCHEME}, manager);

      await tool.runAsync({args: {}, toolContext});

      expect(manager.createSession).toHaveBeenCalledWith({
        Authorization: 'Bearer exchanged-token',
      });
    });
  });

  describe('credential resolution', () => {
    it('returns the pending envelope and never opens a session', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      const tool = createTool({authScheme: API_KEY_SCHEME}, manager);

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(manager.createSession).not.toHaveBeenCalled();
      expect(
        toolContext.eventActions.requestedAuthConfigs['function-call-1'],
      ).toBeDefined();
    });

    it('reuses the cached credential on a second call', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      const getAuthResponse = vi
        .spyOn(toolContext, 'getAuthResponse')
        .mockReturnValueOnce(GRANTED_CREDENTIAL)
        .mockReturnValue(undefined);
      const tool = createTool({authScheme: BEARER_SCHEME}, manager);

      await tool.runAsync({args: {}, toolContext});
      await tool.runAsync({args: {}, toolContext});

      expect(getAuthResponse).toHaveBeenCalledTimes(1);
      expect(manager.createSession).toHaveBeenNthCalledWith(2, {
        Authorization: 'Bearer granted-token',
      });
    });

    it('caches under mcp_<scheme type> when no credentialKey is given', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue(
        GRANTED_CREDENTIAL,
      );
      const tool = createTool({authScheme: BEARER_SCHEME}, manager);

      await tool.runAsync({args: {}, toolContext});

      expect(
        toolContext.state.get('mcp_http_existing_exchanged_credential'),
      ).toEqual(GRANTED_CREDENTIAL);
      expect(
        toolContext.state.get('http_existing_exchanged_credential'),
      ).toBeUndefined();
    });

    it('caches under an explicit credentialKey when one is given', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue(
        GRANTED_CREDENTIAL,
      );
      const tool = createTool(
        {authScheme: BEARER_SCHEME, credentialKey: 'my_server'},
        manager,
      );

      await tool.runAsync({args: {}, toolContext});

      expect(
        toolContext.state.get('my_server_existing_exchanged_credential'),
      ).toEqual(GRANTED_CREDENTIAL);
      expect(
        toolContext.state.get('mcp_http_existing_exchanged_credential'),
      ).toBeUndefined();
    });

    it('asks for consent when an oauth2 credential holds only client details', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      const tool = createTool(
        {
          authScheme: OAUTH2_SCHEME,
          authCredential: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
          },
        },
        manager,
      );

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(manager.createSession).not.toHaveBeenCalled();
      const requested =
        toolContext.eventActions.requestedAuthConfigs['function-call-1'];
      expect(requested?.exchangedAuthCredential?.oauth2?.authUri).toContain(
        'https://example.com/o/oauth2/auth',
      );
    });

    it('sends the token from the consent round trip on the next call', async () => {
      const {manager} = createSessionManager();
      const toolContext = createToolContext();
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue({
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'consented-token'},
      });
      const tool = createTool({authScheme: OAUTH2_SCHEME}, manager);

      await tool.runAsync({args: {}, toolContext});

      expect(manager.createSession).toHaveBeenCalledWith({
        Authorization: 'Bearer consented-token',
      });
    });

    it('ignores a credential given without a scheme', async () => {
      const {manager} = createSessionManager();
      const tool = createTool({authCredential: BEARER_CREDENTIAL}, manager);

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(manager.createSession).toHaveBeenCalledWith(undefined);
    });
  });

  describe('failure paths', () => {
    it('does not call the server when the credential cannot be rendered', async () => {
      const {manager, client} = createSessionManager();
      const tool = createTool(
        {
          authScheme: {type: 'apiKey', name: 'api_key', in: 'query'},
          authCredential: {
            authType: AuthCredentialTypes.API_KEY,
            apiKey: 'secret',
          },
        },
        manager,
      );

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(/located in the header; got: query/);
      expect(manager.createSession).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
    });

    it('propagates an exchange failure instead of calling unauthenticated', async () => {
      const {manager} = createSessionManager();
      const tool = createTool(
        {
          authScheme: OAUTH2_SCHEME,
          authCredential: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {
              clientId: 'client-id',
              clientSecret: 'client-secret',
              authResponseUri: 'https://example.com/callback?error=denied',
            },
          },
        },
        manager,
      );

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(/Authorization code not found/);
      expect(manager.createSession).not.toHaveBeenCalled();
    });

    it('closes the session when the tool call fails', async () => {
      const {manager, client} = createSessionManager();
      vi.mocked(client.callTool).mockRejectedValue(new Error('tool exploded'));
      const tool = createTool(
        {authScheme: BEARER_SCHEME, authCredential: BEARER_CREDENTIAL},
        manager,
      );

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow('tool exploded');
      expect(manager.closeSession).toHaveBeenCalledWith(client);
    });
  });
});
