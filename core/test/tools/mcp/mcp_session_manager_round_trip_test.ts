/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  ElicitationCallback,
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

/** Supplies the transport for the next client the manager opens. */
let nextTransport: () => Transport = () => new InMemoryTransport();

// Only the stdio transport is mocked, to avoid spawning a child process. The
// client and the server are the real MCP SDK implementations, so these tests
// exercise each round trip over a live protocol handshake.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(() => nextTransport()),
  };
});

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-command'},
};

let openSessions: Array<{manager: MCPSessionManager; client: Client}> = [];
let openServers: Server[] = [];

/**
 * Builds a server that is already listening on the returned transport.
 *
 * `strict` makes the server refuse a request whose capability the client never
 * advertised, instead of sending it and reading "method not found" back.
 */
function serve(
  configure?: (server: Server) => void,
  strict = false,
): Transport {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new Server(
    {name: 'test-server', version: '1.0.0'},
    {capabilities: {tools: {}}, enforceStrictCapabilities: strict},
  );
  configure?.(server);
  openServers.push(server);
  // Not awaited: the transport constructor the SDK calls is synchronous. The
  // in-memory transport queues anything the client sends before this resolves.
  void server.connect(serverTransport);
  return clientTransport;
}

/** Opens a session against a fresh server and returns that server. */
async function connect(
  options?: MCPSessionOptions,
  strict = false,
): Promise<Server> {
  nextTransport = () => serve(undefined, strict);
  const manager = new MCPSessionManager(stdioParams, options);
  openSessions.push({manager, client: await manager.createSession()});
  return openServers[openServers.length - 1];
}

/** Builds the tool context an MCPTool needs in order to run. */
function toolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 's1', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      abortSignal: new AbortController().signal,
    }),
  });
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

    const result = await tools[0].runAsync({
      args: {},
      toolContext: toolContext(),
    });

    expect(visited).toEqual(['https://example.com/auth']);
    expect(result).toEqual({content: [{type: 'text', text: 'accept'}]});
    await toolset.close();
  });
});

/** Reads the text out of sampling content, which may be a list of blocks. */
function textOf(content: SamplingMessage['content']): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

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
    // Strict capabilities make the server refuse the request outright, which
    // proves the capability was never advertised. Without them the client
    // answers "method not found", which only proves the handler is missing.
    const server = await connect(undefined, true);

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
    await expect(server.elicitInput(urlParams)).resolves.toEqual({
      action: 'accept',
    });
  });

  it('answers a sampling request raised during a tool call', async () => {
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

    const result = await tools[0].runAsync({
      args: {},
      toolContext: toolContext(),
    });

    expect(seen).toEqual(['hi']);
    expect(result).toEqual({content: [{type: 'text', text: 'sampled'}]});
    await toolset.close();
  });
});
