/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {describe, expect, it, vi} from 'vitest';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';

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

/** Builds a real ReadonlyContext, optionally carrying an abort signal. */
function readonlyContext(abortSignal?: AbortSignal): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      abortSignal,
    }),
  );
}

/** Queues one mocked `Client` construction that behaves as `behaviour`. */
function queueClient(behaviour: Partial<Client>): void {
  vi.mocked(Client).mockImplementationOnce(
    () => behaviour as unknown as Client,
  );
}

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

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
      const tools = await toolset.getTools(readonlyContext());

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

      // Both attempts fail: getTools() retries the listing round trip once.
      const failing = () => ({
        connect: noop(),
        close: noop(),
        listTools: vi.fn().mockRejectedValue(new Error('List tools failed')),
      });
      queueClient(failing());
      queueClient(failing());

      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      await expect(toolset.getTools()).rejects.toThrow('List tools failed');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });
  });

  describe('tool listing retry', () => {
    it('retries the listing once when the first connect rejects', async () => {
      vi.mocked(Client).mockClear();
      queueClient({
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        close: noop(),
      });

      const toolset = new MCPToolset(stdioParams);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(vi.mocked(Client)).toHaveBeenCalledTimes(2);
    });

    it('rejects when both connect attempts reject', async () => {
      vi.mocked(Client).mockClear();
      queueClient({
        connect: vi.fn().mockRejectedValue(new Error('first refused')),
        close: noop(),
      });
      queueClient({
        connect: vi.fn().mockRejectedValue(new Error('second refused')),
        close: noop(),
      });

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools()).rejects.toThrow('second refused');
      expect(vi.mocked(Client)).toHaveBeenCalledTimes(2);
    });

    it('closes the failed attempt session before retrying a rejected listTools', async () => {
      vi.mocked(Client).mockClear();
      queueClient({
        connect: noop(),
        close: noop(),
        listTools: vi.fn().mockRejectedValue(new Error('list boom')),
      });

      const toolset = new MCPToolset(stdioParams);
      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('does not retry when listTools rejects with an AbortError', async () => {
      vi.mocked(Client).mockClear();
      queueClient({
        connect: noop(),
        close: noop(),
        listTools: vi
          .fn()
          .mockRejectedValue(new DOMException('aborted', 'AbortError')),
      });

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools()).rejects.toThrow('aborted');
      expect(vi.mocked(Client)).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('does not retry when the invocation abort signal is already aborted', async () => {
      vi.mocked(Client).mockClear();
      queueClient({
        connect: vi.fn().mockRejectedValue(new Error('refused')),
        close: noop(),
      });

      const controller = new AbortController();
      controller.abort();
      const context = readonlyContext(controller.signal);

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getTools(context)).rejects.toThrow('refused');
      expect(vi.mocked(Client)).toHaveBeenCalledOnce();
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
