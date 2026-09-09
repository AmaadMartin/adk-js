/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  InvocationContext,
  MCPToolset,
} from '@google/adk';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {AuthEchoServer, startAuthEchoServer} from './mcp_auth_server.js';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP
 * server over StreamableHTTP (see `mcp_auth_server.mjs`), which echoes back the
 * `authorization` header it received. This proves a configured credential
 * actually reaches the server.
 */

const TOKEN = 'e2e-test-token';

function createToolContext(): Context {
  const invocationContext = {
    abortSignal: new AbortController().signal,
    session: {state: {}},
  } as unknown as InvocationContext;
  return new Context({invocationContext, functionCallId: 'function-call-1'});
}

function textOf(result: unknown): string | undefined {
  const [part] = (result as CallToolResult).content;
  return part?.type === 'text' ? part.text : undefined;
}

describe('MCP tool auth (e2e, real MCP server over StreamableHTTP)', () => {
  let server: AuthEchoServer;
  let toolset: MCPToolset | undefined;

  beforeEach(async () => {
    server = await startAuthEchoServer();
  });

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
    await server.close();
  });

  it('sends a bearer credential to the server', async () => {
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: server.url},
      [],
      undefined,
      {
        authScheme: {type: 'http', scheme: 'bearer'},
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: TOKEN}},
        },
      },
    );

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(textOf(result)).toBe(`Bearer ${TOKEN}`);
  });

  it('sends an api key under the header the scheme names', async () => {
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: server.url},
      [],
      undefined,
      {
        authScheme: {type: 'apiKey', name: 'Authorization', in: 'header'},
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: TOKEN,
        },
      },
    );

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(textOf(result)).toBe(TOKEN);
  });

  it('sends no authorization header when no auth is configured', async () => {
    toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: server.url,
    });

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(textOf(result)).toBe('none');
  });
});
