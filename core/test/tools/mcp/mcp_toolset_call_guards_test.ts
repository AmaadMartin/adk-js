/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mirrors the guards `TestMcpToolset` covers in adk-python's
 * `tests/unittests/tools/mcp_tool/test_mcp_toolset.py`:
 * `test_get_tools_skips_reserved_names`, `test_get_tools_retry_decorator` and
 * `test_get_tools_with_timeout`.
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  ErrorCode,
  McpError,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  MCP_CONNECTION_ERROR_NAME,
  StdioConnectionParams,
} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {logger} from '../../../src/utils/logger.js';

import {clientStub} from './mcp_context_test_utils.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

/** Connection params for the mocked stdio transport. */
function stdioParams(timeout?: number): StdioConnectionParams {
  return {
    type: 'StdioConnectionParams',
    serverParams: {command: 'test'},
    timeout,
  };
}

/** Makes every session this test opens return `stub`. */
async function useClient(stub: Client): Promise<void> {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  vi.mocked(Client).mockImplementation(() => stub);
}

/** A tool listing whose entries only need a name. */
function toolListing(...names: string[]): ListToolsResult {
  return {
    tools: names.map((name) => ({
      name,
      description: name,
      inputSchema: {type: 'object'},
    })),
  };
}

describe('MCPToolset reserved tool names', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops every reserved name and keeps the rest', async () => {
    await useClient(
      clientStub({
        listTools: vi
          .fn()
          .mockResolvedValue(
            toolListing(
              'valid_tool',
              'transfer_to_agent',
              'adk_request_credential',
              'adk_request_confirmation',
              'adk_request_input',
            ),
          ),
      }),
    );

    const tools = await new MCPToolset(stdioParams()).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['valid_tool']);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Skipping MCP tool 'transfer_to_agent' because it collides with a reserved ADK framework tool name.",
      "Skipping MCP tool 'adk_request_credential' because it collides with a reserved ADK framework tool name.",
      "Skipping MCP tool 'adk_request_confirmation' because it collides with a reserved ADK framework tool name.",
      "Skipping MCP tool 'adk_request_input' because it collides with a reserved ADK framework tool name.",
    ]);
  });

  it('matches the server name, so a prefix does not smuggle a reserved tool in', async () => {
    await useClient(
      clientStub({
        listTools: vi
          .fn()
          .mockResolvedValue(toolListing('valid_tool', 'transfer_to_agent')),
      }),
    );

    const tools = await new MCPToolset(stdioParams(), [], 'srv').getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['srv_valid_tool']);
  });
});

describe('MCPToolset getTools retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a failed listing once and returns the second attempt', async () => {
    const listTools = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValue(toolListing('valid_tool'));
    await useClient(clientStub({listTools}));

    const tools = await new MCPToolset(stdioParams()).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['valid_tool']);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure and names the operation', async () => {
    const listTools = vi.fn().mockRejectedValue(new Error('transport closed'));
    await useClient(clientStub({listTools}));

    await expect(new MCPToolset(stdioParams()).getTools()).rejects.toThrow(
      'Failed to get tools from MCP server: transport closed',
    );
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('keeps the transport error as the cause of the named failure', async () => {
    const cause = new Error('transport closed');
    await useClient(clientStub({listTools: vi.fn().mockRejectedValue(cause)}));

    const error = await new MCPToolset(stdioParams())
      .getTools()
      .catch((err: unknown) => err);

    if (!(error instanceof Error)) {
      expect.fail('getTools should reject with an Error');
    }
    expect(error.name).toBe(MCP_CONNECTION_ERROR_NAME);
    expect(error.cause).toBe(cause);
  });

  it('names the operation when the session never opens', async () => {
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const connect = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Client).mockImplementation(() => clientStub({connect, close}));

    await expect(new MCPToolset(stdioParams()).getTools()).rejects.toThrow(
      'Failed to get tools from MCP server: Failed to create MCP session: spawn failed',
    );
    // No session was ever handed back, so there is nothing to close.
    expect(close).not.toHaveBeenCalled();
  });

  it('does not retry or rewrite a cancellation', async () => {
    const cancelled = new Error('cancelled');
    cancelled.name = 'AbortError';
    const listTools = vi.fn().mockRejectedValue(cancelled);
    await useClient(clientStub({listTools}));

    await expect(new MCPToolset(stdioParams()).getTools()).rejects.toBe(
      cancelled,
    );
    expect(listTools).toHaveBeenCalledOnce();
  });
});

describe('MCPToolset call timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes connectionParams.timeout to the MCP call, in milliseconds', async () => {
    const listTools = vi.fn().mockResolvedValue(toolListing('valid_tool'));
    await useClient(clientStub({listTools}));

    await new MCPToolset(stdioParams(0.25)).getTools();

    expect(listTools).toHaveBeenCalledWith(undefined, {timeout: 250});
  });

  it('leaves the SDK default in place when no timeout is configured', async () => {
    const listTools = vi.fn().mockResolvedValue(toolListing('valid_tool'));
    await useClient(clientStub({listTools}));

    await new MCPToolset(stdioParams()).getTools();

    expect(listTools).toHaveBeenCalledWith(undefined);
  });

  it('names the operation when the SDK cancels a call that timed out', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await useClient(
      clientStub({
        close,
        listTools: vi
          .fn()
          .mockRejectedValue(
            new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
          ),
      }),
    );

    await expect(new MCPToolset(stdioParams(0.01)).getTools()).rejects.toThrow(
      'Failed to get tools from MCP server: MCP error -32001: Request timed out',
    );
    // Once per attempt, so the retry leaves no session behind either.
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('bounds a resource read with the same timeout', async () => {
    const readResource = vi.fn().mockResolvedValue({contents: []});
    await useClient(
      clientStub({
        listResources: vi
          .fn()
          .mockResolvedValue({resources: [{uri: 'file:///a', name: 'res1'}]}),
        readResource,
      }),
    );

    await new MCPToolset(stdioParams(0.25)).readResource('res1');

    expect(readResource).toHaveBeenCalledWith(
      {uri: 'file:///a'},
      {timeout: 250},
    );
  });
});

describe('MCPToolset resource failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a failed resource listing and does not retry it', async () => {
    const listResources = vi.fn().mockRejectedValue(new Error('no resources'));
    await useClient(clientStub({listResources}));

    await expect(new MCPToolset(stdioParams()).listResources()).rejects.toThrow(
      'Failed to list resources from MCP server: no resources',
    );
    expect(listResources).toHaveBeenCalledOnce();
  });

  it('names a failed resource read', async () => {
    await useClient(
      clientStub({
        listResources: vi
          .fn()
          .mockResolvedValue({resources: [{uri: 'file:///a', name: 'res1'}]}),
        readResource: vi.fn().mockRejectedValue(new Error('unreadable')),
      }),
    );

    await expect(
      new MCPToolset(stdioParams()).readResource('res1'),
    ).rejects.toThrow(
      'Failed to get resource res1 from MCP server: unreadable',
    );
  });

  it('reports an unknown resource without naming an MCP operation', async () => {
    await useClient(
      clientStub({
        listResources: vi.fn().mockResolvedValue({resources: []}),
      }),
    );

    const error = await new MCPToolset(stdioParams())
      .getResourceInfo('nope')
      .catch((err: unknown) => err);

    if (!(error instanceof Error)) {
      expect.fail('getResourceInfo should reject with an Error');
    }
    expect(error.message).toBe("Resource with name 'nope' not found.");
    expect(error.name).toBe('Error');
  });
});
