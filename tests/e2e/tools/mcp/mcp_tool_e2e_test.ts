/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  HttpDebugRecord,
  InvocationContext,
  LogLevel,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  createSession,
  setLogLevel,
} from '@google/adk';
import {ChildProcess, spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks over real HTTP to a
 * real MCP App server (spawned as a child process, see `mcp_app_server.mjs`)
 * whose tool declares a `ui://` resource. This proves the widget push and the
 * HTTP debug capture work against an actual server and an actual transport.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_app_server.mjs', import.meta.url),
);

/** Starts the server and resolves once it prints the port it bound. */
function startServer(): Promise<{child: ChildProcess; port: number}> {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('the MCP server produced no stdout'));
      return;
    }
    const lines = createInterface({input: child.stdout});
    lines.on('line', (line) => {
      const match = /^LISTENING (\d+)$/.exec(line);
      if (match) {
        lines.close();
        resolve({child, port: Number(match[1])});
      }
    });
    child.on('exit', (code) =>
      reject(new Error(`the MCP server exited with code ${code}`)),
    );
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 'e2e', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'e2e-call-id',
  });
}

describe('MCPTool (e2e, real MCP App server over HTTP)', () => {
  let child: ChildProcess;
  let tool: MCPTool;

  beforeAll(async () => {
    const started = await startServer();
    child = started.child;
    const sessionManager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: `http://127.0.0.1:${started.port}/mcp`,
      transportOptions: {
        requestInit: {headers: {authorization: 'Bearer e2e-secret'}},
      },
    });
    const session = await sessionManager.createSession();
    const {tools} = await session.listTools();
    await sessionManager.closeSession(session);
    const weather = tools.find((candidate) => candidate.name === 'weather');
    if (!weather) {
      expect.fail('the server did not advertise the weather tool');
    }
    tool = new MCPTool(weather, sessionManager);
  });

  afterAll(() => {
    setLogLevel(LogLevel.INFO);
    child?.kill();
  });

  it('reads the resource URI the server advertised', () => {
    expect(tool.mcpAppResourceUri).toBe('ui://weather-app');
    expect(tool.rawMcpTool.name).toBe('weather');
  });

  it('renders the widget and records the exchange of a real call', async () => {
    setLogLevel(LogLevel.DEBUG);
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toMatchObject({content: [{type: 'text', text: 'sunny'}]});
    expect(toolContext.actions.renderUiWidgets).toEqual([
      {
        id: 'e2e-call-id',
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://weather-app',
          tool: tool.rawMcpTool,
          tool_args: {},
        },
      },
    ]);

    const exchanges = toolContext.customMetadata[
      'http_debug_info'
    ] as HttpDebugRecord[];
    expect(exchanges.length).toBeGreaterThan(0);
    const call = exchanges.find((exchange) =>
      exchange.request_body?.includes('tools/call'),
    );
    if (!call) {
      expect.fail('no tools/call exchange was recorded');
    }
    expect(call.request_headers['authorization']).toBe('<redacted>');
    expect(call.status_code).toBe(200);
  });

  it('records nothing once debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect('http_debug_info' in toolContext.customMetadata).toBe(false);
  });
});
