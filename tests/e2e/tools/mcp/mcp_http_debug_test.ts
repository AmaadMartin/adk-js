/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  getHttpDebugInfo,
  InvocationContext,
  LogLevel,
  MCPToolset,
  PluginManager,
  ReadonlyContext,
  setLogLevel,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
// `resetLogger` is internal, so it is imported by relative path.
import {resetLogger} from '../../../../core/src/utils/logger.js';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP
 * server over real HTTP, with debug logging on. It proves that the HTTP
 * exchanges behind the call reach the invocation's custom metadata, and that
 * the `Authorization` header the client sent is redacted before it gets there.
 */

/** The credential the client sends, which must never reach the metadata. */
const BEARER_TOKEN = 'e2e-secret-token-value';

let httpServer: Server;
let baseUrl: string;

beforeEach(async () => {
  const mcpServer = new McpServer({name: 'e2e-http-server', version: '1.0.0'});
  mcpServer.registerTool(
    'echo',
    {description: 'Echoes its input', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'echoed'}]}),
  );

  // A session id is issued: the stateless mode rejects the client's
  // `notifications/initialized` with a 500, so the handshake never completes.
  // One transport accepts one `initialize`, so each test gets a fresh server.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  httpServer = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const {port} = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  resetLogger();
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

/** A real invocation context, whose `customMetadata` receives the capture. */
function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 's1', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

function createToolset(): MCPToolset {
  return new MCPToolset({
    type: 'StreamableHTTPConnectionParams',
    url: baseUrl,
    transportOptions: {
      requestInit: {headers: {authorization: `Bearer ${BEARER_TOKEN}`}},
    },
  });
}

describe('MCPToolset HTTP debug capture (e2e, real MCP server over HTTP)', () => {
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
  });

  it('records the real HTTP exchanges with the credential redacted', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createReadonlyContext();
    toolset = createToolset();

    const tools = await toolset.getTools(context);

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    const recorded = getHttpDebugInfo(context.invocationContext.customMetadata);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0].url).toBe(baseUrl);
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].requestHeaders['authorization']).toBe('<redacted>');
    expect(JSON.stringify(recorded)).not.toContain(BEARER_TOKEN);
  });

  it('records nothing when debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const context = createReadonlyContext();
    toolset = createToolset();

    await toolset.getTools(context);

    expect(context.invocationContext.customMetadata).toEqual({});
  });
});
