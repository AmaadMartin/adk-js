/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ReadonlyContext} from '../agents/readonly_context.js';

/**
 * Mints headers for one remote MCP turn, from the invocation that asked for
 * it. Use it to carry a token that must be fresh on every turn.
 *
 * Named for the remote server because `tools/mcp/mcp_auth.ts` already exports
 * `McpHeaderProvider` for the client-side session.
 */
export type RemoteMcpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * A remote MCP server that the Managed Agents API runs server-side.
 *
 * The caller describes the endpoint; ADK forwards its URL and headers to the
 * Interactions API, and the backend opens the Model Context Protocol session
 * and runs the tools. Only remote (HTTP or streamable) MCP servers work here.
 *
 * This is server-side MCP. `McpToolset` is the client-side counterpart: it
 * opens the session itself and runs the tools in this process. ADK never
 * connects to the server described here.
 *
 * Mirrors `RemoteMcpServer` in google/adk-python `tools/_remote_mcp_server.py`,
 * which models it as a validated pydantic model. TypeScript rejects an unknown
 * property on an object literal at compile time, which covers the same mistake,
 * and a plain interface keeps this module free of any runtime import.
 */
export interface RemoteMcpServer {
  /**
   * Full URL of the remote MCP server endpoint, for example
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional server label. */
  name?: string;

  /**
   * Static headers sent on every turn, for example a fixed API key. Merged
   * with {@link RemoteMcpServer.headerProvider} output, which wins on a key
   * conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the backend may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time, once per turn. */
  headerProvider?: RemoteMcpHeaderProvider;
}

/**
 * Whether `value` is a {@link RemoteMcpServer} spec.
 *
 * A spec is a plain object carrying a string `url`. Test a `BaseTool` first:
 * a future tool could also expose a `url`, and a tool must never be read as a
 * server spec.
 *
 * @param value The value to test.
 * @return True when `value` has the shape of a server spec.
 */
export function isRemoteMcpServer(value: unknown): value is RemoteMcpServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string'
  );
}
