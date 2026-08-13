/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  ElicitationCallback,
  InvocationContext,
  MCPConnectionParams,
  MCPSessionManager,
  MCPSessionOptions,
  MCPToolset,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** Supplies the transport for the next client the manager opens. */
let nextTransport: () => Transport = () => new InMemoryTransport();

// Only the stdio transport is mocked, to avoid spawning a child process. The
// client and the server are the real MCP SDK implementations, so these tests
// exercise the elicitation round trip over a live protocol handshake.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(() => nextTransport()),
  };
});

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-command'},
};

const urlParams = {
  mode: 'url',
  message: 'Sign in to continue',
  elicitationId: 'e1',
  url: 'https://example.com/auth',
} as const;

const formParams = {
  mode: 'form',
  message: 'Your access token?',
  requestedSchema: {
    type: 'object',
    properties: {token: {type: 'string'}},
  },
} as const;

const SIGN_IN_TOOL = {
  name: 'sign-in',
  description: 'Requires an out-of-band sign-in.',
  inputSchema: {type: 'object' as const, properties: {}},
};

let openSessions: Array<{manager: MCPSessionManager; client: Client}> = [];
let openServers: Server[] = [];

/** Builds a server that is already listening on the returned transport. */
function serve(configure?: (server: Server) => void): Transport {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new Server(
    {name: 'test-server', version: '1.0.0'},
    {capabilities: {tools: {}}},
  );
  configure?.(server);
  openServers.push(server);
  // Not awaited: the transport constructor the SDK calls is synchronous. The
  // in-memory transport queues anything the client sends before this resolves.
  void server.connect(serverTransport);
  return clientTransport;
}

/** Opens a session against a fresh server and returns that server. */
async function connect(options?: MCPSessionOptions): Promise<Server> {
  nextTransport = () => serve();
  const manager = new MCPSessionManager(stdioParams, options);
  openSessions.push({manager, client: await manager.createSession()});
  return openServers[openServers.length - 1];
}

afterEach(async () => {
  for (const {manager, client} of openSessions) {
    await manager.closeSession(client);
  }
  for (const server of openServers) {
    await server.close();
  }
  openSessions = [];
  openServers = [];
  nextTransport = () => new InMemoryTransport();
});

describe('MCPSessionManager elicitation round trip', () => {
  it('answers a URL-mode elicitation with the registered handler', async () => {
    const seen: string[] = [];
    const elicitationCallback: ElicitationCallback = (request) => {
      if (request.params.mode === 'url') {
        seen.push(request.params.url);
      }
      return {action: 'accept'};
    };

    const server = await connect({elicitationCallback});

    await expect(server.elicitInput(urlParams)).resolves.toEqual({
      action: 'accept',
    });
    expect(seen).toEqual(['https://example.com/auth']);
  });

  it('answers a form-mode elicitation with the registered handler', async () => {
    const elicitationCallback: ElicitationCallback = () => ({
      action: 'accept',
      content: {token: 'abc'},
    });

    const server = await connect({elicitationCallback});

    await expect(server.elicitInput(formParams)).resolves.toEqual({
      action: 'accept',
      content: {token: 'abc'},
    });
  });

  it('returns a callback failure to the server as an error', async () => {
    const elicitationCallback: ElicitationCallback = () => {
      throw new Error('handler exploded');
    };

    const server = await connect({elicitationCallback});

    await expect(server.elicitInput(urlParams)).rejects.toThrow(
      'handler exploded',
    );
  });

  it('rejects both elicitation modes when no callback was supplied', async () => {
    const server = await connect();

    await expect(server.elicitInput(urlParams)).rejects.toThrow(
      'Client does not support url elicitation.',
    );
    await expect(server.elicitInput(formParams)).rejects.toThrow(
      'Client does not support form elicitation.',
    );
  });

  it('answers an elicitation raised during a tool call', async () => {
    // MCPToolset opens one session to list tools and another per tool call, so
    // every session gets its own server here.
    nextTransport = () =>
      serve((server) => {
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [SIGN_IN_TOOL],
        }));
        server.setRequestHandler(CallToolRequestSchema, async () => {
          const answer = await server.elicitInput(urlParams);
          return {content: [{type: 'text', text: answer.action}]};
        });
      });

    const visited: string[] = [];
    const toolset = new MCPToolset(stdioParams, [], undefined, {
      elicitationCallback: (request) => {
        if (request.params.mode === 'url') {
          visited.push(request.params.url);
        }
        return {action: 'accept'};
      },
    });

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['sign-in']);

    const invocationContext = {
      abortSignal: new AbortController().signal,
      session: {state: {}},
    } as unknown as InvocationContext;
    const result = await tools[0].runAsync({
      args: {},
      toolContext: new Context({invocationContext}),
    });

    expect(visited).toEqual(['https://example.com/auth']);
    expect(result).toEqual({content: [{type: 'text', text: 'accept'}]});
    await toolset.close();
  });
});
