/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mirrors `TestMcpToolsetHttpDebug` in adk-python's
 * `tests/unittests/tools/mcp_tool/test_mcp_toolset.py`.
 */

import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {StreamableHTTPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import type {HttpExchange} from '../../../src/utils/http_debug_utils.js';
import {LogLevel, setLogLevel} from '../../../src/utils/logger.js';
import {REDACTED_HEADER_VALUE} from '../../../src/utils/redact_headers.js';

import {
  clientStub,
  createTestReadonlyContext,
} from './mcp_context_test_utils.js';

/** Options of the most recently constructed transport. */
const sdk = vi.hoisted(() => ({
  transportOptions: undefined as
    | StreamableHTTPClientTransportOptions
    | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(
    (_url: URL, options: StreamableHTTPClientTransportOptions) => {
      sdk.transportOptions = options;
      return {};
    },
  ),
}));

const MCP_URL = 'https://example.com/mcp';

/** The HTTP answer the fake server gives to every request. */
function serverResponse(): Response {
  return new Response('{"jsonrpc":"2.0","result":{}}', {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

function connectionParams(): StreamableHTTPConnectionParams {
  return {
    type: 'StreamableHTTPConnectionParams',
    url: MCP_URL,
    // The transport's own fetch, which the recorder wraps rather than replaces.
    transportOptions: {fetch: vi.fn().mockResolvedValue(serverResponse())},
  };
}

/**
 * Installs a client whose `listTools` sends one HTTP request through whatever
 * fetch the session manager gave the transport.
 *
 * @param result What the listing resolves to, or an error to reject with.
 */
async function useClientMakingOneRequest(
  result: ListToolsResult | Error,
): Promise<void> {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  vi.mocked(Client).mockImplementation(() =>
    clientStub({
      listTools: vi.fn(async () => {
        await sdk.transportOptions?.fetch?.(MCP_URL, {
          method: 'POST',
          body: '{"method":"tools/list"}',
          headers: {'authorization': 'Bearer token'},
        });
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }),
    }),
  );
}

/** The exchanges an invocation recorded, or `undefined` when it recorded none. */
function recordedExchanges(
  context: ReturnType<typeof createTestReadonlyContext>,
): HttpExchange[] | undefined {
  const recorded = context.invocationContext.customMetadata['http_debug_info'];
  return Array.isArray(recorded) ? (recorded as HttpExchange[]) : undefined;
}

const listing: ListToolsResult = {
  tools: [{name: 'echo', description: 'echo', inputSchema: {type: 'object'}}],
};

describe('MCPToolset HTTP debug capture', () => {
  afterEach(() => {
    setLogLevel(LogLevel.INFO);
    vi.restoreAllMocks();
    sdk.transportOptions = undefined;
  });

  describe('with debug logging on', () => {
    beforeEach(() => {
      setLogLevel(LogLevel.DEBUG);
    });

    it('records the exchange onto the invocation', async () => {
      await useClientMakingOneRequest(listing);
      const context = createTestReadonlyContext();

      await new MCPToolset(connectionParams()).getTools(context);

      const exchanges = recordedExchanges(context);
      expect(exchanges).toHaveLength(1);
      expect(exchanges?.[0].url).toBe(MCP_URL);
      expect(exchanges?.[0].statusCode).toBe(200);
      expect(exchanges?.[0].requestHeaders['authorization']).toBe(
        REDACTED_HEADER_VALUE,
      );
    });

    it('appends a second call rather than replacing the first', async () => {
      await useClientMakingOneRequest(listing);
      const context = createTestReadonlyContext();
      const toolset = new MCPToolset(connectionParams());

      await toolset.getTools(context);
      await toolset.getTools(context);

      expect(recordedExchanges(context)).toHaveLength(2);
    });

    it('still reports what a failed call sent', async () => {
      await useClientMakingOneRequest(new Error('listing rejected'));
      const context = createTestReadonlyContext();

      await expect(
        new MCPToolset(connectionParams()).getTools(context),
      ).rejects.toThrow('Failed to get tools from MCP server');

      // Two attempts, because a failed listing is retried once.
      expect(recordedExchanges(context)).toHaveLength(2);
    });

    it('records nothing and throws nothing when no context is supplied', async () => {
      await useClientMakingOneRequest(listing);

      const tools = await new MCPToolset(connectionParams()).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    });
  });

  describe('with debug logging off', () => {
    it('leaves the invocation untouched and still uses the caller fetch', async () => {
      const params = connectionParams();
      const callerFetch = params.transportOptions?.fetch;
      await useClientMakingOneRequest(listing);
      const context = createTestReadonlyContext();

      await new MCPToolset(params).getTools(context);

      expect(context.invocationContext.customMetadata).toEqual({});
      // The session manager always installs a transparent wrapper, so the
      // guarantee is that the caller's fetch still performs the request, not
      // that it reaches the transport unwrapped.
      expect(callerFetch).toHaveBeenCalledOnce();
    });
  });
});
