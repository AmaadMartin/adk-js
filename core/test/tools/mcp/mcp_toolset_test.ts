/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, ToolConfirmation} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {describe, expect, it, vi} from 'vitest';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';

import {
  clientStub,
  createTestReadonlyContext,
  createTestToolContext,
} from './mcp_context_test_utils.js';

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

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  };
});

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

const httpParams: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://test-url/mcp',
};

/** The headers the most recent session was opened with. */
function lastSessionHeaders(): unknown {
  const call = vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1);
  if (!call) {
    expect.fail('no MCP session was opened');
  }
  return call[1]?.requestInit?.headers;
}

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['other-tool', 'test-tool']);
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'myprefix_other-tool',
      'myprefix_test-tool',
    ]);
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
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockResolvedValue({
                resources: [{uri: 'file:///res1', name: 'res1'}],
              }),
            }) as unknown as Client,
        )
        .mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              readResource,
            }) as unknown as Client,
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
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: '', name: 'res1'}],
            }),
          }) as unknown as Client,
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
        vi.mocked(Client).mockImplementationOnce(
          () =>
            ({
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockRejectedValue(new Error('list boom')),
            }) as unknown as Client,
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
          .mockImplementationOnce(
            () =>
              ({
                connect: noop(),
                close: noop(),
                listResources: vi.fn().mockResolvedValue({
                  resources: [{uri: 'file:///res1', name: 'res1'}],
                }),
              }) as unknown as Client,
          )
          .mockImplementationOnce(
            () =>
              ({
                connect: noop(),
                close: noop(),
                readResource: vi.fn().mockRejectedValue(new Error('read boom')),
              }) as unknown as Client,
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

  describe('connection params', () => {
    it('rejects a missing connection params value', () => {
      // The cast stands in for a JavaScript caller: the guard exists for a
      // caller TypeScript does not check.
      expect(
        () => new MCPToolset(undefined as unknown as MCPConnectionParams),
      ).toThrow('Missing connection params in MCPToolset.');
    });
  });

  describe('tool order', () => {
    it('keeps both tools when a server advertises one name twice', async () => {
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockResolvedValue({
            tools: [
              {name: 'twin', description: 'first', inputSchema: {}},
              {name: 'twin', description: 'second', inputSchema: {}},
            ],
          }),
        }),
      );
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.description)).toEqual([
        'first',
        'second',
      ]);
    });

    it('returns the tools sorted by name', async () => {
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockResolvedValue({
            tools: [
              {name: 'zebra', description: 'z', inputSchema: {}},
              {name: 'alpha', description: 'a', inputSchema: {}},
              {name: 'mango', description: 'm', inputSchema: {}},
            ],
          }),
        }),
      );
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'alpha',
        'mango',
        'zebra',
      ]);
    });
  });

  describe('headerProvider', () => {
    it('sends the headers a sync provider returns', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        headerProvider: () => ({'X-Tenant-ID': 'tenant-a'}),
      });

      await toolset.getTools(createTestReadonlyContext());

      expect(lastSessionHeaders()).toEqual({'x-tenant-id': 'tenant-a'});
    });

    it('sends the headers an async provider resolves to', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        headerProvider: async () => ({'X-Tenant-ID': 'tenant-b'}),
      });

      await toolset.getTools(createTestReadonlyContext());

      expect(lastSessionHeaders()).toEqual({'x-tenant-id': 'tenant-b'});
    });

    it('reads the invocation state the provider was given', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        headerProvider: (context) => ({
          'X-Tenant-ID': String(context.state.get('tenant')),
        }),
      });

      await toolset.getTools(createTestReadonlyContext({tenant: 'tenant-c'}));

      expect(lastSessionHeaders()).toEqual({'x-tenant-id': 'tenant-c'});
    });

    it('lets the auth header win a collision with the provider', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        authScheme: {type: 'http', scheme: 'bearer'},
        headerProvider: () => ({
          Authorization: 'Bearer spoofed',
          'X-Tenant-ID': 'tenant-a',
        }),
      });
      const authConfig = toolset.getAuthConfig();
      if (!authConfig) {
        expect.fail('the toolset built no auth config');
      }
      authConfig.exchangedAuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'real-token'},
      };

      await toolset.getTools(createTestReadonlyContext());

      expect(lastSessionHeaders()).toEqual({
        'authorization': 'Bearer real-token',
        'x-tenant-id': 'tenant-a',
      });
    });

    it('is not called when getTools gets no context', async () => {
      const headerProvider = vi.fn().mockReturnValue({'X-Tenant-ID': 'a'});
      const toolset = new MCPToolset(httpParams, [], undefined, {
        headerProvider,
      });

      await toolset.getTools();

      expect(headerProvider).not.toHaveBeenCalled();
      expect(lastSessionHeaders()).toBeUndefined();
    });

    it('propagates a rejecting provider instead of listing unauthenticated', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, {
        headerProvider: () => Promise.reject(new Error('no tenant')),
      });

      await expect(
        toolset.getTools(createTestReadonlyContext()),
      ).rejects.toThrow('no tenant');
    });
  });

  describe('useMcpResources', () => {
    it('appends one load_mcp_resource tool after the sorted tools', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        useMcpResources: true,
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'other-tool',
        'test-tool',
        'load_mcp_resource',
      ]);
    });

    it('appends nothing by default', async () => {
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).not.toContain('load_mcp_resource');
    });
  });

  describe('requireConfirmation', () => {
    it('gates every tool the toolset returns', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        requireConfirmation: true,
      });

      const tools = await toolset.getTools();

      const gated = await Promise.all(
        tools.map((tool) =>
          tool.checkRequireConfirmation({}, createTestToolContext()),
        ),
      );
      expect(gated).toEqual([true, true]);
    });

    it('gates nothing by default', async () => {
      const toolset = new MCPToolset(stdioParams);

      const [tool] = await toolset.getTools();

      await expect(
        tool.checkRequireConfirmation({}, createTestToolContext()),
      ).resolves.toBe(false);
    });

    it('calls the predicate with the arguments and the tool context', async () => {
      const requireConfirmation = vi.fn().mockReturnValue(true);
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        requireConfirmation,
      });
      const toolContext = createTestToolContext();

      const [tool] = await toolset.getTools();
      await tool.checkRequireConfirmation({path: '/tmp'}, toolContext);

      expect(requireConfirmation).toHaveBeenCalledWith(
        {path: '/tmp'},
        toolContext,
      );
    });

    it('asks for approval instead of opening a session', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        requireConfirmation: true,
      });
      const [tool] = await toolset.getTools();
      const sessionsBefore = vi.mocked(Client).mock.calls.length;
      const toolContext = createTestToolContext();

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(vi.mocked(Client).mock.calls).toHaveLength(sessionsBefore);
      expect(
        toolContext.eventActions.requestedToolConfirmations,
      ).toHaveProperty('test-function-call-id');
    });

    it('calls the server once the user approves', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        requireConfirmation: true,
      });
      const [tool] = await toolset.getTools();
      const toolContext = createTestToolContext();
      toolContext.toolConfirmation = new ToolConfirmation({confirmed: true});
      vi.mocked(Client).mockImplementationOnce(() => clientStub({callTool}));

      await tool.runAsync({args: {}, toolContext});

      expect(callTool).toHaveBeenCalledOnce();
    });

    it('refuses the call once the user rejects', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        requireConfirmation: true,
      });
      const [tool] = await toolset.getTools();
      const toolContext = createTestToolContext();
      toolContext.toolConfirmation = new ToolConfirmation({confirmed: false});
      const sessionsBefore = vi.mocked(Client).mock.calls.length;

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({error: 'This tool call is rejected.'});
      expect(vi.mocked(Client).mock.calls).toHaveLength(sessionsBefore);
    });
  });

  describe('progress callbacks', () => {
    it('passes the shared callback to every tool call', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const progressCallback = vi.fn();
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        progressCallback,
      });

      const [tool] = await toolset.getTools();
      vi.mocked(Client).mockImplementationOnce(() => clientStub({callTool}));
      await tool.runAsync({args: {}, toolContext: createTestToolContext()});

      const options = callTool.mock.calls[0][2];
      expect(options.onprogress).toBeTypeOf('function');
      options.onprogress({progress: 1, total: 2});
      // The adapter defers by one microtask, so the callback can be async.
      await Promise.resolve();
      expect(progressCallback).toHaveBeenCalledWith({progress: 1, total: 2});
    });

    it('asks the factory for a callback named after the tool', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const progressCallbackFactory = vi.fn().mockReturnValue(undefined);
      const toolset = new MCPToolset(stdioParams, [], 'myprefix', {
        progressCallbackFactory,
      });

      const [tool] = await toolset.getTools();
      vi.mocked(Client).mockImplementationOnce(() => clientStub({callTool}));
      const toolContext = createTestToolContext();
      await tool.runAsync({args: {}, toolContext});

      expect(progressCallbackFactory).toHaveBeenCalledWith(
        'myprefix_other-tool',
        {callbackContext: toolContext},
      );
      expect(callTool.mock.calls[0][2].onprogress).toBeUndefined();
    });
  });

  describe('server-to-client callbacks', () => {
    it('declares no capability by default', async () => {
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools();

      expect(Client).toHaveBeenLastCalledWith({
        name: 'MCPClient',
        version: '1.0.0',
      });
    });

    it('declares the sampling capability when a callback is configured', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        samplingCallback: vi.fn(),
      });
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockResolvedValue({tools: []}),
          setRequestHandler: vi.fn(),
        }),
      );

      await toolset.getTools();

      expect(Client).toHaveBeenLastCalledWith(
        {name: 'MCPClient', version: '1.0.0'},
        {capabilities: {sampling: {}}},
      );
    });

    it('declares the elicitation capability when a callback is configured', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, {
        elicitationCallback: vi.fn(),
      });
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockResolvedValue({tools: []}),
          setRequestHandler: vi.fn(),
        }),
      );

      await toolset.getTools();

      expect(Client).toHaveBeenLastCalledWith(
        {name: 'MCPClient', version: '1.0.0'},
        {capabilities: {elicitation: {}}},
      );
    });
  });

  describe('close', () => {
    it('does not throw when a session refuses to close', async () => {
      let sessionOpened!: () => void;
      const opened = new Promise<void>((resolve) => {
        sessionOpened = resolve;
      });
      let releaseList!: () => void;
      const listed = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          close: vi.fn().mockRejectedValue(new Error('close boom')),
          listTools: vi.fn().mockImplementation(() => {
            sessionOpened();
            return listed.then(() => ({tools: []}));
          }),
        }),
      );

      const toolset = new MCPToolset(stdioParams);
      const pending = toolset.getTools();
      await opened;

      await expect(toolset.close()).resolves.toBeUndefined();

      releaseList();
      await expect(pending).resolves.toEqual([]);
    });
  });
});
