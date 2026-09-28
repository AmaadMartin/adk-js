/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  AuthScheme,
  MCPConnectionParams,
  MCPToolset,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {clientStub, createTestToolContext} from './mcp_context_test_utils.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const httpParams: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://test-url/mcp',
};

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

/** The headers the most recent session was opened with. */
function lastSessionHeaders(): unknown {
  const call = vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1);
  if (!call) {
    expect.fail('no MCP session was opened');
  }
  return call[1]?.requestInit?.headers;
}

describe('MCPToolset auth', () => {
  beforeEach(() => {
    vi.mocked(StreamableHTTPClientTransport).mockClear();
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        listTools: vi.fn().mockResolvedValue({
          tools: [{name: 'alpha', description: 'a', inputSchema: {}}],
        }),
      }),
    );
  });

  describe('getAuthConfig', () => {
    it('returns undefined without an auth scheme', () => {
      const toolset = new MCPToolset(httpParams);

      expect(toolset.getAuthConfig()).toBeUndefined();
    });

    it('carries the scheme, the raw credential and the credential key', () => {
      const authCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'raw-key',
      };
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
        authCredential,
        credentialKey: 'example-mcp',
      });

      expect(toolset.getAuthConfig()).toEqual({
        authScheme: apiKeyScheme,
        rawAuthCredential: authCredential,
        credentialKey: 'example-mcp',
      });
    });

    it('falls back to a default credential key', () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
      });

      expect(toolset.getAuthConfig()?.credentialKey).toBe('default_mcp_key');
    });

    it('returns the same instance every call', () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
      });

      expect(toolset.getAuthConfig()).toBe(toolset.getAuthConfig());
    });
  });

  describe('auth headers', () => {
    it('sends no headers when there is no auth config', async () => {
      const toolset = new MCPToolset(httpParams);

      await toolset.getTools();

      expect(lastSessionHeaders()).toBeUndefined();
    });

    it('sends no headers when the credential was never exchanged', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'raw-key',
        },
      });

      await toolset.getTools();

      expect(lastSessionHeaders()).toBeUndefined();
    });

    it('sends the header derived from the exchanged credential', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
      });
      const authConfig = toolset.getAuthConfig();
      if (!authConfig) {
        expect.fail('the toolset built no auth config');
      }
      authConfig.exchangedAuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'exchanged-key',
      };

      await toolset.getTools();

      expect(lastSessionHeaders()).toEqual({'x-api-key': 'exchanged-key'});
    });

    it('sends a bearer header for an exchanged OAuth2 credential', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: {type: 'http', scheme: 'bearer'},
      });
      const authConfig = toolset.getAuthConfig();
      if (!authConfig) {
        expect.fail('the toolset built no auth config');
      }
      authConfig.exchangedAuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'access-token'},
      };

      await toolset.getTools();

      expect(lastSessionHeaders()).toEqual({
        authorization: 'Bearer access-token',
      });
    });

    it('reaches the tools the toolset created, not just the listing', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: apiKeyScheme,
      });
      const authConfig = toolset.getAuthConfig();
      if (!authConfig) {
        expect.fail('the toolset built no auth config');
      }
      authConfig.exchangedAuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'exchanged-key',
      };

      const [tool] = await toolset.getTools();
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({callTool: vi.fn().mockResolvedValue({content: []})}),
      );
      await tool.runAsync({args: {}, toolContext: createTestToolContext()});

      expect(lastSessionHeaders()).toEqual({'x-api-key': 'exchanged-key'});
    });
  });
});
