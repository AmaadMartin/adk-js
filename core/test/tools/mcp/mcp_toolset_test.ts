/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Writable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {
  McpConnectionError,
  MCPConnectionParams,
} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {
  isCapturingHttpDebug,
  MAX_CAPTURED_EXCHANGES,
  recordHttpExchange,
} from '../../../src/utils/http_debug_utils.js';
import {LogLevel, resetLogger, setLogLevel} from '../../../src/utils/logger.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {name: 'test-tool', description: 'A test tool', inputSchema: {}},
          {name: 'other-tool', description: 'Another tool', inputSchema: {}},
        ],
      }),
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {uri: 'file:///res1', name: 'res1'},
          {uri: 'file:///res2', name: 'res2'},
        ],
      }),
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello'},
        ],
      }),
    })),
  };
});

/** A client method stub that resolves to nothing (connect/close). */
const noop = () => vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

/**
 * Builds a stub MCP client for the mocked SDK module. The one cast lives here:
 * the module is `vi.mock`ed, so a test supplies only the client methods it
 * exercises, which cannot satisfy the full `Client` type.
 */
function stubClient(methods: Record<string, unknown>): Client {
  return {connect: noop(), close: noop(), ...methods} as unknown as Client;
}

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-tool');
    expect(tools[1].name).toBe('other-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('myprefix_test-tool');
    expect(tools[1].name).toBe('myprefix_other-tool');
  });

  describe('toolFilter', () => {
    it('empty array (default) returns all tools', async () => {
      const toolset = new MCPToolset(stdioParams, []);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('string array filter returns only matching tools', async () => {
      const toolset = new MCPToolset(stdioParams, ['test-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
    });

    it('string array filter with prefix matches prefixed names', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        ['myprefix_test-tool'],
        'myprefix',
      );
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('myprefix_test-tool');
    });

    it('string array filter returns empty when no tools match', async () => {
      const toolset = new MCPToolset(stdioParams, ['nonexistent-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(0);
    });

    it('predicate filter applies when context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      const tools = await toolset.getTools({} as ReadonlyContext);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('other-tool');
    });

    it('predicate filter returns all tools when no context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      // No context passed — filter cannot be applied, returns all tools
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });
  });

  describe('cleanup', () => {
    it('closes the session and leaves activeSessions empty after getTools success', async () => {
      const toolset = new MCPToolset(stdioParams);
      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('closes the session and leaves activeSessions empty even if listTools throws an error', async () => {
      const toolset = new MCPToolset(stdioParams);

      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const mockClientInstance = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockRejectedValue(new Error('List tools failed')),
      };
      vi.mocked(Client).mockImplementationOnce(
        () => mockClientInstance as unknown as Client,
      );

      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      await expect(toolset.getTools()).rejects.toThrow('List tools failed');
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });
  });

  describe('resources', () => {
    it('listResources returns the mapped resource names', async () => {
      const toolset = new MCPToolset(stdioParams);

      const names = await toolset.listResources();

      expect(names).toEqual(['res1', 'res2']);
    });

    it('getResourceInfo returns the matching resource', async () => {
      const toolset = new MCPToolset(stdioParams);

      const info = await toolset.getResourceInfo('res1');

      expect(info.name).toBe('res1');
      expect(info.uri).toBe('file:///res1');
    });

    it('getResourceInfo rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getResourceInfo('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource resolves the URI and returns the contents', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const readResource = vi.fn().mockResolvedValue({
        contents: [{uri: 'file:///res1', text: 'hello'}],
      });
      vi.mocked(Client)
        .mockImplementationOnce(() =>
          stubClient({
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: 'file:///res1', name: 'res1'}],
            }),
          }),
        )
        .mockImplementationOnce(() =>
          stubClient({
            readResource,
          }),
        );

      const toolset = new MCPToolset(stdioParams);
      const contents = await toolset.readResource('res1');

      expect(readResource).toHaveBeenCalledWith({uri: 'file:///res1'});
      expect(contents).toEqual([{uri: 'file:///res1', text: 'hello'}]);
    });

    it('readResource rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource rejects when the resolved resource has no URI', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({
          listResources: vi.fn().mockResolvedValue({
            resources: [{uri: '', name: 'res1'}],
          }),
        }),
      );

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('res1')).rejects.toThrow(
        "Resource 'res1' has no URI.",
      );
    });

    describe('cleanup', () => {
      it('closes the session after listResources succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.listResources();

        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes the session even if the client listResources rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client).mockImplementationOnce(() =>
          stubClient({
            listResources: vi.fn().mockRejectedValue(new Error('list boom')),
          }),
        );

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.listResources()).rejects.toThrow('list boom');
        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions after readResource succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.readResource('res1');

        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions even if the client readResource rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client)
          .mockImplementationOnce(() =>
            stubClient({
              listResources: vi.fn().mockResolvedValue({
                resources: [{uri: 'file:///res1', name: 'res1'}],
              }),
            }),
          )
          .mockImplementationOnce(() =>
            stubClient({
              readResource: vi.fn().mockRejectedValue(new Error('read boom')),
            }),
          );

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.readResource('res1')).rejects.toThrow('read boom');
        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });
    });
  });

  describe('error context', () => {
    /** Installs a one-shot client whose `listTools` rejects with `err`. */
    async function clientRejectingListTools(err: unknown): Promise<void> {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({
          listTools: vi.fn().mockRejectedValue(err),
        }),
      );
    }

    it('names the failed operation when listTools rejects', async () => {
      await clientRejectingListTools(new Error('socket hang up'));
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools()).rejects.toThrow(
        'Failed to get tools from MCP server: socket hang up',
      );
    });

    it('rejects with an McpConnectionError carrying the original cause', async () => {
      const original = new Error('socket hang up');
      await clientRejectingListTools(original);
      const toolset = new MCPToolset(stdioParams);

      const error = await toolset.getTools().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(McpConnectionError);
      expect((error as McpConnectionError).name).toBe('McpConnectionError');
      expect((error as McpConnectionError).cause).toBe(original);
    });

    it('names the failed operation when the session cannot be opened', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({
          connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        }),
      );
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools()).rejects.toThrow(
        /^Failed to get tools from MCP server: .*ECONNREFUSED/,
      );
    });

    it('leaves a cancellation untouched instead of naming it', async () => {
      const aborted = new Error('The operation was aborted');
      aborted.name = 'AbortError';
      await clientRejectingListTools(aborted);
      const toolset = new MCPToolset(stdioParams);

      const error = await toolset.getTools().catch((err: unknown) => err);

      expect(error).toBe(aborted);
      expect(error).not.toBeInstanceOf(McpConnectionError);
    });

    it('names a listResources failure', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({
          listResources: vi.fn().mockRejectedValue(new Error('list boom')),
        }),
      );
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.listResources()).rejects.toThrow(
        'Failed to list resources from MCP server: list boom',
      );
    });

    it('names a getResourceInfo failure as a listing failure', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({
          listResources: vi.fn().mockRejectedValue(new Error('list boom')),
        }),
      );
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getResourceInfo('res1')).rejects.toThrow(
        'Failed to list resources from MCP server: list boom',
      );
    });

    it('names a readResource failure with the resource name', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client)
        .mockImplementationOnce(() =>
          stubClient({
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: 'file:///res1', name: 'res1'}],
            }),
          }),
        )
        .mockImplementationOnce(() =>
          stubClient({
            readResource: vi.fn().mockRejectedValue(new Error('read boom')),
          }),
        );
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('res1')).rejects.toThrow(
        'Failed to get resource res1 from MCP server: read boom',
      );
    });

    it('keeps the unknown-resource error unnamed', async () => {
      const toolset = new MCPToolset(stdioParams);

      const error = await toolset
        .getResourceInfo('nope')
        .catch((err: unknown) => err);

      expect(error).not.toBeInstanceOf(McpConnectionError);
      expect((error as Error).message).toBe(
        "Resource with name 'nope' not found.",
      );
    });
  });

  describe('errlog', () => {
    /** A writable stream that keeps everything written to it. */
    function capturingStream(): Writable {
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    }

    /** A tool context with the minimum the MCP tool reads from it. */
    function createToolContext(): Context {
      return new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          session: createSession({id: 's1', appName: 'app', userId: 'user'}),
          pluginManager: new PluginManager([]),
        }),
      });
    }

    it('asks the stdio server to pipe its stderr when a tool runs', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        errlog: capturingStream(),
      });
      const tools = await toolset.getTools();
      vi.mocked(StdioClientTransport).mockClear();
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({callTool: vi.fn().mockResolvedValue({content: []})}),
      );

      await tools[0].runAsync({args: {}, toolContext: createToolContext()});

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test',
        stderr: 'pipe',
      });
    });

    it('leaves the stdio server stderr inherited when no errlog is set', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const toolset = new MCPToolset(stdioParams);
      const tools = await toolset.getTools();
      vi.mocked(StdioClientTransport).mockClear();
      vi.mocked(Client).mockImplementationOnce(() =>
        stubClient({callTool: vi.fn().mockResolvedValue({content: []})}),
      );

      await tools[0].runAsync({args: {}, toolContext: createToolContext()});

      expect(StdioClientTransport).toHaveBeenCalledWith({command: 'test'});
    });
  });

  describe('http debug capture', () => {
    /** A real invocation context, so `customMetadata` behaves as it does live. */
    function createReadonlyContext(): ReadonlyContext {
      return new ReadonlyContext(
        new InvocationContext({
          invocationId: 'inv-1',
          session: createSession({
            id: 'session-1',
            appName: 'app',
            userId: 'user',
          }),
          pluginManager: new PluginManager([]),
        }),
      );
    }

    /**
     * Installs a one-shot client whose `listTools` records `count` exchanges,
     * as the transport's fetch wrapper does for a real HTTP server.
     */
    async function clientRecording(count: number): Promise<void> {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listTools: vi.fn().mockImplementation(async () => {
              for (let i = 0; i < count; i++) {
                recordHttpExchange({
                  url: `https://mcp.example.com/${i}`,
                  method: 'POST',
                  statusCode: 200,
                  requestHeaders: {authorization: 'Bearer super-secret'},
                  responseHeaders: {},
                  responseBody: 'ok',
                });
              }
              return {tools: []};
            }),
          }) as unknown as Client,
      );
    }

    beforeEach(() => {
      resetLogger();
      setLogLevel(LogLevel.DEBUG);
    });

    afterEach(() => {
      resetLogger();
    });

    it('drains the captured exchanges into the invocation metadata', async () => {
      await clientRecording(1);
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools(context);

      expect(context.invocationContext.customMetadata).toEqual({
        http_debug_info: [
          {
            url: 'https://mcp.example.com/0',
            method: 'POST',
            statusCode: 200,
            requestHeaders: {authorization: '<redacted>'},
            responseHeaders: {},
            requestBody: undefined,
            responseBody: 'ok',
          },
        ],
      });
    });

    it('records nothing when debug logging is off', async () => {
      setLogLevel(LogLevel.INFO);
      await clientRecording(1);
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools(context);

      expect(context.invocationContext.customMetadata).toEqual({});
    });

    it('adds no key when the call recorded no exchange', async () => {
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools(context);

      expect(context.invocationContext.customMetadata).toEqual({});
    });

    it('records nothing when no context was passed', async () => {
      await clientRecording(1);
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools).toEqual([]);
      expect(isCapturingHttpDebug()).toBe(false);
    });

    it('appends to the existing list on a second call', async () => {
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await clientRecording(1);
      await toolset.getTools(context);
      await clientRecording(1);
      await toolset.getTools(context);

      expect(
        context.invocationContext.customMetadata['http_debug_info'],
      ).toHaveLength(2);
    });

    it('caps the accumulated list', async () => {
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await clientRecording(MAX_CAPTURED_EXCHANGES);
      await toolset.getTools(context);
      await clientRecording(5);
      await toolset.getTools(context);

      expect(
        context.invocationContext.customMetadata['http_debug_info'],
      ).toHaveLength(MAX_CAPTURED_EXCHANGES);
    });

    it('drains the exchanges captured before a failure', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listTools: vi.fn().mockImplementation(async () => {
              recordHttpExchange({
                url: 'https://mcp.example.com/failing',
                method: 'POST',
                statusCode: 500,
                requestHeaders: {},
                responseHeaders: {},
                responseBody: 'server error',
              });
              throw new Error('list boom');
            }),
          }) as unknown as Client,
      );
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools(context)).rejects.toThrow('list boom');

      expect(
        context.invocationContext.customMetadata['http_debug_info'],
      ).toEqual([
        expect.objectContaining({url: 'https://mcp.example.com/failing'}),
      ]);
    });

    it('records a listResources call against the context', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockImplementation(async () => {
              recordHttpExchange({
                url: 'https://mcp.example.com/resources',
                method: 'POST',
                statusCode: 200,
                requestHeaders: {},
                responseHeaders: {},
                responseBody: 'ok',
              });
              return {resources: [{uri: 'file:///res1', name: 'res1'}]};
            }),
          }) as unknown as Client,
      );
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      const names = await toolset.listResources(context);

      expect(names).toEqual(['res1']);
      expect(
        context.invocationContext.customMetadata['http_debug_info'],
      ).toEqual([
        expect.objectContaining({url: 'https://mcp.example.com/resources'}),
      ]);
    });

    it('records a getResourceInfo call against the context', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockImplementation(async () => {
              recordHttpExchange({
                url: 'https://mcp.example.com/info',
                method: 'POST',
                statusCode: 200,
                requestHeaders: {},
                responseHeaders: {},
                responseBody: 'ok',
              });
              return {resources: [{uri: 'file:///res1', name: 'res1'}]};
            }),
          }) as unknown as Client,
      );
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      const info = await toolset.getResourceInfo('res1', context);

      expect(info.uri).toBe('file:///res1');
      expect(
        context.invocationContext.customMetadata['http_debug_info'],
      ).toEqual([
        expect.objectContaining({url: 'https://mcp.example.com/info'}),
      ]);
    });

    it('records both sessions of a readResource call against the context', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client)
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockImplementation(async () => {
                recordHttpExchange({
                  url: 'https://mcp.example.com/list',
                  method: 'POST',
                  statusCode: 200,
                  requestHeaders: {},
                  responseHeaders: {},
                  responseBody: 'ok',
                });
                return {resources: [{uri: 'file:///res1', name: 'res1'}]};
              }),
            }) as unknown as Client,
        )
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              readResource: vi.fn().mockImplementation(async () => {
                recordHttpExchange({
                  url: 'https://mcp.example.com/read',
                  method: 'POST',
                  statusCode: 200,
                  requestHeaders: {},
                  responseHeaders: {},
                  responseBody: 'ok',
                });
                return {contents: [{uri: 'file:///res1', text: 'hello'}]};
              }),
            }) as unknown as Client,
        );
      const context = createReadonlyContext();
      const toolset = new MCPToolset(stdioParams);

      await toolset.readResource('res1', context);

      const recorded = context.invocationContext.customMetadata[
        'http_debug_info'
      ] as Array<{url: string}>;
      expect(recorded.map((entry) => entry.url)).toEqual([
        'https://mcp.example.com/list',
        'https://mcp.example.com/read',
      ]);
    });
  });
});
