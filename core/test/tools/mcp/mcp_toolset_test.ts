/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR,
  Context,
  InvocationContext,
  LlmRequest,
  ToolConfirmation,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CreateMessageResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, Mock, vi} from 'vitest';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {logger} from '../../../src/utils/logger.js';

const {defaultClient} = vi.hoisted(() => {
  vi.resetModules();
  return {
    defaultClient: () => ({
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
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(defaultClient),
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

/** A minimal valid MCP tool descriptor. */
function mcpTool(name: string): Tool {
  return {name, description: '', inputSchema: {type: 'object'}};
}

/**
 * Makes every client this test builds advertise `tools`, and merges `overrides`
 * onto the stub. Returns the shared `listTools` spy so a test can count calls.
 *
 * The default implementation is restored after each test, so one test's stub
 * never reaches the next.
 */
function stubListTools(
  tools: Tool[],
  overrides: Partial<Record<string, unknown>> = {},
): Mock {
  const listTools = vi.fn().mockResolvedValue({tools});
  // Calls accumulate across tests, so a test asserting on the constructor
  // arguments must start from an empty record.
  vi.mocked(Client).mockClear();
  vi.mocked(Client).mockImplementation(
    () =>
      ({
        ...defaultClient(),
        listTools,
        callTool: vi.fn().mockResolvedValue({content: []}),
        setRequestHandler: vi.fn(),
        ...overrides,
      }) as unknown as Client,
  );
  return listTools;
}

afterEach(() => {
  vi.mocked(Client).mockImplementation(
    () => defaultClient() as unknown as Client,
  );
});

/**
 * A real tool context over a stub invocation. `functionCallId` is set because
 * `requestConfirmation` refuses to raise a request without one.
 */
function createToolContext(
  options: {toolConfirmation?: ToolConfirmation} = {},
) {
  const invocationContext = {
    abortSignal: new AbortController().signal,
    session: {state: {}},
  } as unknown as InvocationContext;

  return new Context({
    invocationContext,
    functionCallId: 'call-1',
    toolConfirmation: options.toolConfirmation,
  });
}

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    // getTools() now sorts by name, so 'other-tool' comes first.
    expect(tools[0].name).toBe('other-tool');
    expect(tools[1].name).toBe('test-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    // getTools() now sorts by name, so 'myprefix_other-tool' comes first.
    expect(tools[0].name).toBe('myprefix_other-tool');
    expect(tools[1].name).toBe('myprefix_test-tool');
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

  describe('options constructor', () => {
    it('discovers tools when configured with an options object', async () => {
      const toolset = new MCPToolset({connectionParams: stdioParams});
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'other-tool',
        'test-tool',
      ]);
    });

    it('applies the toolFilter and prefix given as options', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolFilter: ['myprefix_other-tool'],
        prefix: 'myprefix',
      });
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['myprefix_other-tool']);
    });
  });

  describe('useMcpResources', () => {
    it('adds no resource tool when the option is omitted', async () => {
      const toolset = new MCPToolset(stdioParams);
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).not.toContain('load_mcp_resource');
    });

    it('adds no resource tool when the option is false', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        useMcpResources: false,
      });
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('appends exactly one resource tool, last', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        useMcpResources: true,
      });
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'other-tool',
        'test-tool',
        'load_mcp_resource',
      ]);
    });

    it('keeps the resource tool when a toolFilter drops every server tool', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolFilter: ['nonexistent-tool'],
        useMcpResources: true,
      });
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['load_mcp_resource']);
    });

    it('keeps the resource tool unprefixed when a prefix is configured', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        prefix: 'myprefix',
        useMcpResources: true,
      });
      const tools = await toolset.getTools();

      expect(tools[tools.length - 1].name).toBe('load_mcp_resource');
    });

    it('keeps the resource tool when a predicate filter runs', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolFilter: (tool) => tool.name === 'other-tool',
        useMcpResources: true,
      });
      const tools = await toolset.getTools({} as ReadonlyContext);

      expect(tools.map((tool) => tool.name)).toEqual([
        'other-tool',
        'load_mcp_resource',
      ]);
    });

    it('reads the toolset it was appended to', async () => {
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        useMcpResources: true,
      });
      const tools = await toolset.getTools();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tools[tools.length - 1].processLlmRequest({
        toolContext: {} as Context,
        llmRequest,
      });

      expect(llmRequest.config?.systemInstruction).toContain('res1');
    });
  });

  describe('fromConfig', () => {
    const originalEnvValue = process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];

    afterEach(() => {
      if (originalEnvValue === undefined) {
        delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];
      } else {
        process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = originalEnvValue;
      }
    });

    it('builds a toolset from streamable HTTP params', async () => {
      const toolset = MCPToolset.fromConfig({
        streamableHttpConnectionParams: {
          type: 'StreamableHTTPConnectionParams',
          url: 'https://example.test/mcp',
        },
      });
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('carries toolFilter, prefix and useMcpResources onto the toolset', async () => {
      process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = '1';

      const toolset = MCPToolset.fromConfig({
        stdioConnectionParams: {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test'},
        },
        toolFilter: ['myprefix_test-tool'],
        prefix: 'myprefix',
        useMcpResources: true,
      });
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'myprefix_test-tool',
        'load_mcp_resource',
      ]);
    });

    it('refuses a stdio server the application has not opted in to', () => {
      delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];

      expect(() =>
        MCPToolset.fromConfig({
          stdioConnectionParams: {
            type: 'StdioConnectionParams',
            serverParams: {command: 'test'},
          },
        }),
      ).toThrow(/not allowed in agent configs/);
    });
  });

  describe('sorting', () => {
    it('returns tools name-ascending regardless of listing order', async () => {
      stubListTools([mcpTool('charlie'), mcpTool('alpha'), mcpTool('bravo')]);
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'alpha',
        'bravo',
        'charlie',
      ]);
    });
  });

  describe('reserved tool names', () => {
    it('drops every framework-reserved name and warns', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      stubListTools([
        mcpTool('valid_tool'),
        mcpTool('transfer_to_agent'),
        mcpTool('adk_request_credential'),
        mcpTool('adk_request_confirmation'),
        mcpTool('adk_request_input'),
      ]);
      const toolset = new MCPToolset(stdioParams);

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['valid_tool']);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls[0][0]).toContain('transfer_to_agent');
      warn.mockRestore();
    });

    it('reads the advertised name, not the prefixed one', async () => {
      stubListTools([mcpTool('transfer_to_agent'), mcpTool('safe')]);
      const toolset = new MCPToolset(stdioParams, [], 'srv');

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['srv_safe']);
    });
  });

  describe('tool list cache', () => {
    it('lists again on every call when no lifetime is configured', async () => {
      const listTools = stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools();
      await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(2);
    });

    it('lists once within the lifetime and returns equal tools', async () => {
      const listTools = stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolListCacheTtlSeconds: 60,
      });

      const first = await toolset.getTools();
      const second = await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(1);
      expect(second.map((tool) => tool.name)).toEqual(
        first.map((tool) => tool.name),
      );
    });

    it('lists again once the lifetime passes', async () => {
      vi.useFakeTimers();
      const listTools = stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolListCacheTtlSeconds: 60,
      });

      await toolset.getTools();
      vi.advanceTimersByTime(60_000);
      await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('does not share an entry between two header identities', async () => {
      const listTools = stubListTools([mcpTool('alpha')]);
      let token = 'first';
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolListCacheTtlSeconds: 60,
        headerProvider: () => ({authorization: token}),
      });

      await toolset.getTools();
      token = 'second';
      await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(2);
    });

    it('reuses an entry when the header identity repeats', async () => {
      const listTools = stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolListCacheTtlSeconds: 60,
        headerProvider: async () => ({authorization: 'same'}),
      });

      await toolset.getTools();
      await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(1);
    });

    it('still runs the tool filter on a cache hit', async () => {
      stubListTools([mcpTool('alpha'), mcpTool('bravo')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolFilter: ['bravo'],
        toolListCacheTtlSeconds: 60,
      });

      await toolset.getTools();
      const second = await toolset.getTools();

      expect(second.map((tool) => tool.name)).toEqual(['bravo']);
    });

    it('lists again after close clears the cache', async () => {
      const listTools = stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        toolListCacheTtlSeconds: 60,
      });

      await toolset.getTools();
      await toolset.close();
      await toolset.getTools();

      expect(listTools).toHaveBeenCalledTimes(2);
    });

    it.each([0, -1])('rejects a lifetime of %i', (ttl) => {
      expect(
        () =>
          new MCPToolset({
            connectionParams: stdioParams,
            toolListCacheTtlSeconds: ttl,
          }),
      ).toThrow(/must be positive/);
    });
  });

  describe('requireConfirmation', () => {
    it('reports that confirmation is required', async () => {
      stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        requireConfirmation: true,
      });

      const [tool] = await toolset.getTools();

      expect(await tool.checkRequireConfirmation({})).toBe(true);
    });

    it('evaluates a predicate against the call arguments', async () => {
      stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        requireConfirmation: (args) => args['path'] !== undefined,
      });

      const [tool] = await toolset.getTools();

      expect(await tool.checkRequireConfirmation({path: '/tmp'})).toBe(true);
      expect(await tool.checkRequireConfirmation({})).toBe(false);
    });

    it('defaults to no confirmation', async () => {
      stubListTools([mcpTool('alpha')]);
      const toolset = new MCPToolset(stdioParams);

      const [tool] = await toolset.getTools();

      expect(await tool.checkRequireConfirmation({})).toBe(false);
    });

    it('raises a confirmation request instead of calling the server', async () => {
      const callTool = vi.fn();
      stubListTools([mcpTool('alpha')], {
        callTool,
      });
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        requireConfirmation: true,
      });
      const toolContext = createToolContext();

      const [tool] = await toolset.getTools();
      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(
        toolContext.actions.requestedToolConfirmations['call-1'],
      ).toMatchObject({confirmed: false});
      expect(toolContext.actions.skipSummarization).toBe(true);
    });

    it('returns the rejection payload when the user declined', async () => {
      const callTool = vi.fn();
      stubListTools([mcpTool('alpha')], {
        callTool,
      });
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        requireConfirmation: true,
      });
      const toolContext = createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      });

      const [tool] = await toolset.getTools();
      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({error: 'This tool call is rejected.'});
      expect(callTool).not.toHaveBeenCalled();
    });

    it('reaches the server once the user approved', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      stubListTools([mcpTool('alpha')], {
        callTool,
      });
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        requireConfirmation: true,
      });
      const toolContext = createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      });

      const [tool] = await toolset.getTools();
      await tool.runAsync({args: {}, toolContext});

      expect(callTool).toHaveBeenCalledOnce();
    });
  });

  describe('progress notifications', () => {
    it('passes progressCallback to the call and fires it', async () => {
      const progress: number[] = [];
      const callTool = vi.fn().mockResolvedValue({content: []});
      stubListTools([mcpTool('alpha')], {
        callTool,
      });
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        progressCallback: (update) => {
          progress.push(update.progress);
        },
      });

      const [tool] = await toolset.getTools();
      await tool.runAsync({args: {}, toolContext: createToolContext()});

      const options = callTool.mock.calls[0][2];
      options.onprogress({progress: 0.5, total: 1});

      expect(progress).toEqual([0.5]);
    });

    it('omits onprogress when neither option is configured', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      stubListTools([mcpTool('alpha')], {
        callTool,
      });
      const toolset = new MCPToolset(stdioParams);

      const [tool] = await toolset.getTools();
      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(callTool.mock.calls[0][2]).not.toHaveProperty('onprogress');
    });
  });

  describe('sampling and elicitation', () => {
    it('advertises no capabilities when neither callback is set', async () => {
      const setRequestHandler = vi.fn();
      stubListTools([], {setRequestHandler});
      const toolset = new MCPToolset(stdioParams);

      await toolset.getTools();

      expect(vi.mocked(Client).mock.calls[0]).toHaveLength(1);
      expect(setRequestHandler).not.toHaveBeenCalled();
    });

    it('advertises sampling and answers a createMessage request', async () => {
      const setRequestHandler = vi.fn();
      stubListTools([], {setRequestHandler});
      const result: CreateMessageResult = {
        model: 'm',
        role: 'assistant',
        content: {type: 'text', text: 'hi'},
      };
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        samplingCallback: () => result,
      });

      await toolset.getTools();

      expect(vi.mocked(Client).mock.calls[0][1]).toEqual({
        capabilities: {sampling: {}},
      });
      const [, handler] = setRequestHandler.mock.calls[0];
      expect(await handler({method: 'sampling/createMessage'})).toBe(result);
    });

    it('passes custom sampling capabilities through verbatim', async () => {
      stubListTools([], {setRequestHandler: vi.fn()});
      const samplingCapabilities = {context: {maxTokens: 100}};
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        samplingCallback: () => {
          throw new Error('not called in this test');
        },
        samplingCapabilities,
      });

      await toolset.getTools();

      expect(vi.mocked(Client).mock.calls[0][1]).toEqual({
        capabilities: {sampling: samplingCapabilities},
      });
    });

    it('advertises elicitation and answers an elicit request', async () => {
      const setRequestHandler = vi.fn();
      stubListTools([], {setRequestHandler});
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        elicitationCallback: async () => ({action: 'decline' as const}),
      });

      await toolset.getTools();

      expect(vi.mocked(Client).mock.calls[0][1]).toEqual({
        capabilities: {elicitation: {}},
      });
      const [, handler] = setRequestHandler.mock.calls[0];
      expect(await handler({method: 'elicitation/create'})).toEqual({
        action: 'decline',
      });
    });

    it('advertises both when both callbacks are set', async () => {
      stubListTools([], {setRequestHandler: vi.fn()});
      const toolset = new MCPToolset({
        connectionParams: stdioParams,
        samplingCallback: () => {
          throw new Error('not called in this test');
        },
        elicitationCallback: () => ({action: 'decline' as const}),
      });

      await toolset.getTools();

      expect(vi.mocked(Client).mock.calls[0][1]).toEqual({
        capabilities: {sampling: {}, elicitation: {}},
      });
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
