/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `ToolboxToolset` against a real HTTP server over a loopback socket,
 * with nothing mocked: the real `@toolbox-sdk/core` client speaks its real
 * protocol to the server below, and the tools it returns are real
 * `FunctionTool`s.
 *
 * The server answers the two methods the client uses, from an in-memory tool
 * list. It is not an MCP Toolbox for Databases deployment, so it proves the
 * adapter and the wire format, not the database behind a real server.
 */

import {
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ToolboxToolset,
} from '@google/adk';
import {Type} from '@google/genai';
import {createServer, IncomingMessage, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const SEARCH_HOTELS = {
  name: 'search-hotels',
  description: 'Finds hotels in a city.',
  inputSchema: {
    type: 'object',
    properties: {
      city: {type: 'string', description: 'The city to search in.'},
    },
    required: ['city'],
  },
};

const BROKEN_TOOL = {
  name: 'broken-tool',
  description: 'A tool the server refuses to run.',
  inputSchema: {type: 'object', properties: {}},
};

interface JsonRpcRequest {
  id?: string;
  method: string;
  params?: {name?: string; arguments?: Record<string, unknown>};
}

/** Answers `tools/list` and `tools/call` for the two tools above. */
function handle(request: JsonRpcRequest): Record<string, unknown> {
  if (request.method === 'tools/list') {
    return {result: {tools: [SEARCH_HOTELS, BROKEN_TOOL]}};
  }
  if (request.params?.name === 'broken-tool') {
    return {error: {code: -32000, message: 'the database is offline'}};
  }
  const city = request.params?.arguments?.['city'];
  return {
    result: {content: [{type: 'text', text: `The Grand Hotel, ${city}`}]},
  };
}

function readBody(stream: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => resolve(body));
    stream.on('error', reject);
  });
}

function createToolContext(): Context {
  const agent = new LlmAgent({name: 'hotel_agent', model: 'gemini-2.0-flash'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'toolbox-integration',
      agent,
      session: createSession({
        id: 'toolbox-session',
        appName: 'hotel_agent',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

describe('ToolboxToolset against a live toolbox server', () => {
  let server: Server;
  let serverUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        const request = JSON.parse(body) as JsonRpcRequest;
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(
          JSON.stringify({jsonrpc: '2.0', id: request.id, ...handle(request)}),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('loads a toolset and calls one of its tools', async () => {
    const toolset = new ToolboxToolset(serverUrl, {toolsetName: 'hotels'});
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search-hotels',
      'broken-tool',
    ]);
    // The SDK builds its zod schema from the parameter types alone, so the
    // description the server sends for a parameter does not reach the model.
    const parameters = tools[0]._getDeclaration()?.parameters;
    expect(parameters?.properties?.['city']).toEqual({type: Type.STRING});
    expect(parameters?.required).toEqual(['city']);

    const result = await tools[0].runAsync({
      args: {city: 'Paris'},
      toolContext: createToolContext(),
    });
    expect(result).toBe('The Grand Hotel, Paris');

    await toolset.close();
  });

  it('loads an individually named tool', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['search-hotels'],
    });
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['search-hotels']);
    expect(tools[0].description).toBe('Finds hotels in a city.');

    await toolset.close();
  });

  it('fails when the server does not know the tool', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['no-such-tool'],
    });

    await expect(toolset.getTools()).rejects.toThrow(/no-such-tool/);

    await toolset.close();
  });

  it('surfaces an error the server returns for a call', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['broken-tool'],
    });
    const [tool] = await toolset.getTools();

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow(/the database is offline/);

    await toolset.close();
  });
});
