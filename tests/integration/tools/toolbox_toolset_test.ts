/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives {@link ToolboxToolset} through the real `@toolbox-sdk/core` client
 * against a loopback server that speaks the Toolbox wire protocol: JSON-RPC
 * `tools/list` and `tools/call` over HTTP POST. Nothing is mocked, so a change
 * in the SDK that breaks the toolset shows up here.
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  ToolboxCredentialStrategy,
  ToolboxToolset,
} from '@google/adk';
import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

/** A tool as the server advertises it in a `tools/list` result. */
interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Toolbox's MCP extension naming the auth services a parameter needs. */
  _meta?: Record<string, unknown>;
}

const CITY_SCHEMA = {
  type: 'object',
  properties: {city: {type: 'string', description: 'The city to search'}},
  required: ['city'],
};

const HOTEL_TOOLS: AdvertisedTool[] = [
  {
    name: 'search_hotels',
    description: 'Searches hotels in a city.',
    inputSchema: CITY_SCHEMA,
  },
  {
    name: 'book_hotel',
    description: 'Books a hotel.',
    inputSchema: CITY_SCHEMA,
  },
];

/** A tool whose `userId` parameter the server fills from an auth token. */
const AUTH_TOOLS: AdvertisedTool[] = [
  {
    name: 'my_bookings',
    description: 'Lists the bookings of the signed-in user.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {type: 'string'},
        userId: {type: 'string'},
      },
      required: ['city', 'userId'],
    },
    _meta: {'com.google.cloud/authParam': {userId: ['my-google-auth']}},
  },
];

const FLIGHT_TOOLS: AdvertisedTool[] = [
  {
    name: 'search_flights',
    description: 'Searches flights to a city.',
    inputSchema: CITY_SCHEMA,
  },
];

/** Every request the stub server received, in arrival order. */
interface RecordedRequest {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  params: Record<string, unknown>;
}

const requests: RecordedRequest[] = [];

/** Set to make the next `tools/call` answer with a JSON-RPC error. */
let callError: {code: number; message: string} | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** The toolsets the server publishes; the empty name is the default one. */
const TOOLSETS: Record<string, AdvertisedTool[]> = {
  '': [...HOTEL_TOOLS, ...FLIGHT_TOOLS],
  'hotel-tools': HOTEL_TOOLS,
  'flight-tools': FLIGHT_TOOLS,
  'auth-tools': AUTH_TOOLS,
};

/**
 * Answers `tools/list` with the toolset named in the path, and `tools/call`
 * by echoing the arguments back as text.
 */
function resultFor(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === 'tools/list') {
    return {tools: TOOLSETS[path.replace(/^\/mcp\/?/, '')] ?? []};
  }
  return {
    content: [
      {
        type: 'text',
        text: `${params['name']} ran with ${JSON.stringify(params['arguments'])}`,
      },
    ],
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as {
    id: string;
    method: string;
    params: Record<string, unknown>;
  };
  requests.push({
    path: req.url ?? '',
    method: body.method,
    headers: req.headers,
    params: body.params,
  });

  const failing = body.method === 'tools/call' && callError !== undefined;
  const payload = failing
    ? {jsonrpc: '2.0', id: body.id, error: callError}
    : {
        jsonrpc: '2.0',
        id: body.id,
        result: resultFor(req.url ?? '', body.method, body.params),
      };
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}

let server: Server;
let serverUrl: string;

function toolContext(state?: Record<string, unknown>): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'toolbox-integration',
      session: createSession({id: 'session', appName: 'app', state}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'call-1',
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('the stub server did not bind a TCP port');
  }
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  requests.length = 0;
  callError = undefined;
});

describe('ToolboxToolset against a Toolbox server', () => {
  it('loads every tool of the default toolset', async () => {
    const toolset = new ToolboxToolset(serverUrl);

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_hotels',
      'book_hotel',
      'search_flights',
    ]);
    expect(requests.map((request) => request.path)).toEqual(['/mcp/']);
    await toolset.close();
  });

  it('declares the advertised description and parameters', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['search_hotels'],
    });

    const [tool] = await toolset.getTools();

    // The SDK's zod schema keeps each parameter's name, type and
    // requiredness but not its description, so the declaration has none.
    expect(tool._getDeclaration()).toEqual({
      name: 'search_hotels',
      description: 'Searches hotels in a city.',
      parameters: {
        type: 'OBJECT',
        properties: {city: {type: 'STRING'}},
        required: ['city'],
      },
    });
    await toolset.close();
  });

  it('loads the named toolset and then the named tools', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolsetName: 'flight-tools',
      toolNames: ['book_hotel'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_flights',
      'book_hotel',
    ]);
    // The two loads run concurrently, so they can reach the server in either
    // order; only the returned tool order is fixed.
    expect(requests.map((request) => request.path).sort()).toEqual([
      '/mcp/',
      '/mcp/flight-tools',
    ]);
    await toolset.close();
  });

  it('round-trips the arguments and returns the server text', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
    });

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {city: 'Basel'},
      toolContext: toolContext(),
    });

    expect(result).toBe('book_hotel ran with {"city":"Basel"}');
    const call = requests.find((request) => request.method === 'tools/call');
    expect(call?.params).toMatchObject({
      name: 'book_hotel',
      arguments: {city: 'Basel'},
    });
    await toolset.close();
  });

  it('binds a parameter so the model never supplies it', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
      boundParams: {city: () => 'Zurich'},
    });

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({args: {}, toolContext: toolContext()});

    expect(tool._getDeclaration()?.parameters).toEqual({
      type: 'OBJECT',
      properties: {},
    });
    expect(result).toBe('book_hotel ran with {"city":"Zurich"}');
    await toolset.close();
  });

  it('sends the value of a dynamic additionalHeaders getter', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
      additionalHeaders: {'x-api-key': async () => 'from-getter'},
    });

    await toolset.getTools();

    expect(requests[0].headers['x-api-key']).toBe('from-getter');
    await toolset.close();
  });

  it('surfaces a server error raised by a tool call', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
    });
    const [tool] = await toolset.getTools();
    callError = {code: -32000, message: 'hotel service is down'};

    await expect(
      tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()}),
    ).rejects.toThrow('hotel service is down');
    await toolset.close();
  });

  it('sends a manual token credential on every request', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
      credentials: ToolboxCredentialStrategy.manualToken('secret-token'),
    });

    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});

    expect(requests.map((request) => request.headers['authorization'])).toEqual(
      ['Bearer secret-token', 'Bearer secret-token'],
    );
    await toolset.close();
  });

  it('sends an api key credential in its own header', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
      credentials: ToolboxCredentialStrategy.apiKey('secret-key', 'X-Api-Key'),
    });

    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});

    expect(requests.map((request) => request.headers['x-api-key'])).toEqual([
      'secret-key',
      'secret-key',
    ]);
    await toolset.close();
  });

  it('derives an auth token from the tool context of the invocation', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolsetName: 'auth-tools',
      authTokenGetters: {
        'my-google-auth': (context) => String(context.state.get('idToken')),
      },
    });
    const context = toolContext({idToken: 'token-of-alice'});

    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    // The auth-gated parameter is hidden from the model, and the SDK sends
    // the token as `<service>_token`.
    expect(tool._getDeclaration()?.parameters).toEqual({
      type: 'OBJECT',
      properties: {city: {type: 'STRING'}},
      required: ['city'],
    });
    const call = requests.find((request) => request.method === 'tools/call');
    expect(call?.headers['my-google-auth_token']).toBe('token-of-alice');
    await toolset.close();
  });

  it('reports the client name and version it is configured with', async () => {
    const toolset = new ToolboxToolset(serverUrl, {
      toolNames: ['book_hotel'],
      clientOptions: {clientName: 'my-agent', clientVersion: '9.9.9'},
    });

    await toolset.getTools();

    // The SDK sends its identity in the request metadata, not a header.
    const meta = requests[0].params['_meta'] as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual({
      name: 'my-agent',
      version: '9.9.9',
    });
    await toolset.close();
  });

  it('reports an unknown tool name', async () => {
    const toolset = new ToolboxToolset(serverUrl, {toolNames: ['no_such']});

    await expect(toolset.getTools()).rejects.toThrow(/no_such/);
    await toolset.close();
  });
});
