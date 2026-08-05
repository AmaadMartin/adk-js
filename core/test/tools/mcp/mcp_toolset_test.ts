/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseAgent} from '../../../src/agents/base_agent.js';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {
  MCPHeaderProvider,
  MCPToolset,
} from '../../../src/tools/mcp/mcp_toolset.js';

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
      callTool: vi.fn().mockResolvedValue({content: []}),
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
  url: 'http://test-url',
  transportOptions: {requestInit: {headers: {'X-Static': 'yes'}}},
};

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

  describe('headerProvider', () => {
    /** Options handed to the most recently constructed HTTP transport. */
    const lastTransportOptions = () =>
      vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1];

    beforeEach(() => {
      vi.mocked(StreamableHTTPClientTransport).mockClear();
      vi.mocked(StdioClientTransport).mockClear();
      vi.mocked(Client).mockClear();
    });

    it('no headerProvider leaves transport options unchanged', async () => {
      const toolset = new MCPToolset(httpParams);

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'X-Static': 'yes'}},
      });
    });

    it('invokes the provider once per getTools() call and uses the fresh value', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementationOnce(async () => ({Authorization: 'Bearer t1'}))
        .mockImplementationOnce(async () => ({Authorization: 'Bearer t2'}));
      const toolset = new MCPToolset(httpParams, [], undefined, provider);

      await toolset.getTools();
      const firstOptions = lastTransportOptions();
      await toolset.getTools();

      expect(provider).toHaveBeenCalledTimes(2);
      expect(firstOptions).toEqual({
        requestInit: {headers: {'X-Static': 'yes', Authorization: 'Bearer t1'}},
      });
      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'X-Static': 'yes', Authorization: 'Bearer t2'}},
      });
    });

    it('merges provider headers over static transportOptions headers', async () => {
      const params: MCPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            headers: {'X-Static': 'yes', Authorization: 'Bearer old'},
          },
        },
      };
      const toolset = new MCPToolset(params, [], undefined, async () => ({
        Authorization: 'Bearer new',
      }));

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {'X-Static': 'yes', Authorization: 'Bearer new'},
        },
      });
    });

    it('passes the ReadonlyContext to the provider', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementation(async () => ({}));
      const context = {} as ReadonlyContext;
      const toolset = new MCPToolset(httpParams, [], undefined, provider);

      await toolset.getTools(context);

      expect(provider).toHaveBeenCalledWith(context);
    });

    it('calls the provider with undefined when getTools() has no context', async () => {
      const provider = vi
        .fn<MCPHeaderProvider>()
        .mockImplementation(async () => ({}));
      const toolset = new MCPToolset(httpParams, [], undefined, provider);

      await toolset.getTools();

      expect(provider).toHaveBeenCalledWith(undefined);
    });

    it('supports a synchronous provider', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, () => ({
        Authorization: 'Bearer sync',
      }));

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {'X-Static': 'yes', Authorization: 'Bearer sync'},
        },
      });
    });

    it('an empty provider result leaves transport options unchanged', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, () => ({}));

      await toolset.getTools();

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'X-Static': 'yes'}},
      });
    });

    it('propagates a provider rejection and creates no session', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, async () => {
        throw new Error('token fetch failed');
      });

      await expect(toolset.getTools()).rejects.toThrow('token fetch failed');
      expect(Client).not.toHaveBeenCalled();
      expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    });

    it('resolved headers are handed to the returned MCPTools', async () => {
      const toolset = new MCPToolset(httpParams, [], undefined, () => ({
        Authorization: 'Bearer call',
      }));

      const tools = await toolset.getTools();
      const toolContext = new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          agent: {} as BaseAgent,
          session: createSession({id: 'session-1', appName: 'app'}),
          pluginManager: new PluginManager(),
          abortSignal: new AbortController().signal,
        }),
      });
      await tools[0].runAsync({args: {}, toolContext});

      // Two transports: the discovery session, then the tool-call session.
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {'X-Static': 'yes', Authorization: 'Bearer call'},
        },
      });
    });

    it('works with a stdio transport', async () => {
      const toolset = new MCPToolset(stdioParams, [], undefined, () => ({
        Authorization: 'Bearer ignored',
      }));

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(StdioClientTransport).toHaveBeenCalledWith({command: 'test'});
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
});
