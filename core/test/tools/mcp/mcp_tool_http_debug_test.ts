/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {MCPSessionManager} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPTool} from '../../../src/tools/mcp/mcp_tool.js';
import {
  getHttpDebugInfo,
  HttpExchange,
  recordHttpExchange,
} from '../../../src/utils/http_debug_utils.js';
import {LogLevel, resetLogger, setLogLevel} from '../../../src/utils/logger.js';

const remoteTool: Tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: {type: 'object', properties: {}},
};

/**
 * A session manager that hands out one client and opens no transport, so a
 * test drives `MCPTool` without a server.
 */
class StubSessionManager extends MCPSessionManager {
  readonly client: Client;

  constructor(callTool: Client['callTool']) {
    super({type: 'StdioConnectionParams', serverParams: {command: 'test'}});
    this.client = new Client({name: 'test-client', version: '1.0.0'});
    this.client.callTool = callTool;
  }

  override createSession(): Promise<Client> {
    return Promise.resolve(this.client);
  }

  override closeSession(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A `callTool` that records `url` as an exchange, the way the transport's
 * fetch wrapper records one for a real HTTP server, and then answers.
 */
function callToolRecording(url: string): Client['callTool'] {
  return async () => {
    recordHttpExchange({
      url,
      method: 'POST',
      statusCode: 200,
      requestHeaders: {authorization: 'Bearer super-secret'},
      responseHeaders: {},
      responseBody: 'ok',
    });
    return {content: []};
  };
}

/** A tool context on a real invocation, so `customMetadata` behaves as it does live. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

/** The exchanges recorded against the invocation behind `toolContext`. */
function recorded(toolContext: Context): HttpExchange[] {
  return getHttpDebugInfo(toolContext.invocationContext.customMetadata);
}

describe('MCPTool http debug capture', () => {
  beforeEach(() => {
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    resetLogger();
  });

  it('drains the exchanges of a successful call into the invocation metadata', async () => {
    const tool = new MCPTool(
      remoteTool,
      new StubSessionManager(callToolRecording('https://mcp.example.com/call')),
    );
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(recorded(toolContext)).toEqual([
      {
        url: 'https://mcp.example.com/call',
        method: 'POST',
        statusCode: 200,
        requestHeaders: {authorization: '<redacted>'},
        responseHeaders: {},
        responseBody: 'ok',
      },
    ]);
  });

  it('records nothing when debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const tool = new MCPTool(
      remoteTool,
      new StubSessionManager(callToolRecording('https://mcp.example.com/call')),
    );
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.invocationContext.customMetadata).toEqual({});
  });

  it('drains the exchanges of a failed call and rethrows the error', async () => {
    const failing: Client['callTool'] = async (...args) => {
      await callToolRecording('https://mcp.example.com/call')(...args);
      throw new Error('gateway refused the call');
    };
    const tool = new MCPTool(remoteTool, new StubSessionManager(failing));
    const toolContext = createToolContext();

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'gateway refused the call',
    );

    expect(recorded(toolContext)).toHaveLength(1);
    expect(recorded(toolContext)[0].url).toBe('https://mcp.example.com/call');
  });

  it('appends the exchanges of a second call to those of the first', async () => {
    const tool = new MCPTool(
      remoteTool,
      new StubSessionManager(callToolRecording('https://mcp.example.com/call')),
    );
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});
    await tool.runAsync({args: {}, toolContext});

    expect(recorded(toolContext)).toHaveLength(2);
  });

  it('keeps two concurrent calls from sharing a capture', async () => {
    const first = new MCPTool(
      remoteTool,
      new StubSessionManager(callToolRecording('https://first.example.com/')),
    );
    const second = new MCPTool(
      remoteTool,
      new StubSessionManager(callToolRecording('https://second.example.com/')),
    );
    const firstContext = createToolContext();
    const secondContext = createToolContext();

    await Promise.all([
      first.runAsync({args: {}, toolContext: firstContext}),
      second.runAsync({args: {}, toolContext: secondContext}),
    ]);

    expect(recorded(firstContext).map((entry) => entry.url)).toEqual([
      'https://first.example.com/',
    ]);
    expect(recorded(secondContext).map((entry) => entry.url)).toEqual([
      'https://second.example.com/',
    ]);
  });
});
