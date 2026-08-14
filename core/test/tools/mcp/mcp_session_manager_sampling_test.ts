/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  MCPConnectionParams,
  MCPSessionManager,
  MCPSessionOptions,
  MCPToolset,
  PluginManager,
  SamplingCallback,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** Reads the text out of sampling content, which may be a list of blocks. */
function textOf(content: SamplingMessage['content']): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

/** Supplies the transport for the next client the manager opens. */
let nextTransport: () => Transport = () => new InMemoryTransport();

// Only the stdio transport is mocked, to avoid spawning a child process. The
// client and the server are the real MCP SDK implementations, so these tests
// exercise the sampling round trip over a live protocol handshake.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(() => nextTransport()),
  };
});

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-command'},
};

const sampleParams = {
  messages: [
    {role: 'user' as const, content: {type: 'text' as const, text: 'hi'}},
  ],
  maxTokens: 100,
};

const toolsParams = {
  ...sampleParams,
  tools: [
    {
      name: 'lookup',
      description: 'Looks something up.',
      inputSchema: {type: 'object' as const, properties: {}},
    },
  ],
};

const reply = {
  model: 'test-model',
  role: 'assistant' as const,
  content: {type: 'text' as const, text: 'sampled'},
  stopReason: 'endTurn',
};

const SUMMARISE_TOOL = {
  name: 'summarise',
  description: 'Asks the client to summarise something.',
  inputSchema: {type: 'object' as const, properties: {}},
};

let openSessions: Array<{manager: MCPSessionManager; client: Client}> = [];
let openServers: Server[] = [];

/** Builds a server that is already listening on the returned transport. */
function serve(configure?: (server: Server) => void): Transport {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // Strict capabilities make the server refuse a request the client never
  // advertised support for, instead of sending it and getting "method not
  // found" back. That is what pins "no callback means no capability".
  const server = new Server(
    {name: 'test-server', version: '1.0.0'},
    {capabilities: {tools: {}}, enforceStrictCapabilities: true},
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

describe('MCPSessionManager sampling round trip', () => {
  it('answers a sampling request with the registered handler', async () => {
    const seen: string[] = [];
    const samplingCallback: SamplingCallback = (request) => {
      seen.push(textOf(request.params.messages[0].content));
      return reply;
    };

    const server = await connect({samplingCallback});

    await expect(server.createMessage(sampleParams)).resolves.toEqual(reply);
    expect(seen).toEqual(['hi']);
  });

  it('awaits a callback that returns a promise', async () => {
    const samplingCallback: SamplingCallback = async () => reply;

    const server = await connect({samplingCallback});

    await expect(server.createMessage(sampleParams)).resolves.toEqual(reply);
  });

  it('returns a callback failure to the server as an error', async () => {
    const samplingCallback: SamplingCallback = () => {
      throw new Error('handler exploded');
    };

    const server = await connect({samplingCallback});

    await expect(server.createMessage(sampleParams)).rejects.toThrow(
      'handler exploded',
    );
  });

  it('rejects sampling when no callback was supplied', async () => {
    const server = await connect();

    await expect(server.createMessage(sampleParams)).rejects.toThrow(
      'Client does not support sampling',
    );
  });

  it('advertises plain sampling when no capabilities are supplied', async () => {
    const server = await connect({samplingCallback: () => reply});

    await expect(server.createMessage(toolsParams)).rejects.toThrow(
      'Client does not support sampling tools capability.',
    );
  });

  it('advertises tool-use sampling when samplingCapabilities asks for it', async () => {
    const seen: string[] = [];
    const samplingCallback: SamplingCallback = (request) => {
      seen.push(...(request.params.tools ?? []).map((tool) => tool.name));
      return reply;
    };

    const server = await connect({
      samplingCallback,
      samplingCapabilities: {tools: {}},
    });

    await expect(server.createMessage(toolsParams)).resolves.toEqual(reply);
    expect(seen).toEqual(['lookup']);
  });

  it('advertises sampling alongside elicitation when both callbacks are supplied', async () => {
    const server = await connect({
      samplingCallback: () => reply,
      elicitationCallback: () => ({action: 'accept'}),
    });

    await expect(server.createMessage(sampleParams)).resolves.toEqual(reply);
    await expect(
      server.elicitInput({
        mode: 'url',
        message: 'Sign in to continue',
        elicitationId: 'e1',
        url: 'https://example.com/auth',
      }),
    ).resolves.toEqual({action: 'accept'});
  });

  it('answers a sampling request raised during a tool call', async () => {
    // MCPToolset opens one session to list tools and another per tool call, so
    // every session gets its own server here.
    nextTransport = () =>
      serve((server) => {
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [SUMMARISE_TOOL],
        }));
        server.setRequestHandler(CallToolRequestSchema, async () => {
          const sampled = await server.createMessage(sampleParams);
          return {content: [{type: 'text', text: textOf(sampled.content)}]};
        });
      });

    const seen: string[] = [];
    const toolset = new MCPToolset(stdioParams, [], undefined, {
      samplingCallback: (request) => {
        seen.push(textOf(request.params.messages[0].content));
        return reply;
      },
    });

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['summarise']);

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 's1', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      abortSignal: new AbortController().signal,
    });
    const result = await tools[0].runAsync({
      args: {},
      toolContext: new Context({invocationContext}),
    });

    expect(seen).toEqual(['hi']);
    expect(result).toEqual({content: [{type: 'text', text: 'sampled'}]});
    await toolset.close();
  });
});
