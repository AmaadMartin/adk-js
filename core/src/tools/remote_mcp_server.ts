/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ReadonlyContext} from '../agents/readonly_context.js';

/**
 * Mints headers for a remote MCP server at request time, e.g. a fresh bearer
 * token. Called once per turn while the agent resolves its tools.
 */
export type McpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * A remote MCP server the Managed Agents backend runs, not this process.
 *
 * `ManagedAgent` forwards the URL and headers to `interactions.create`; the
 * backend opens the MCP session and executes the tools. Only remote
 * (HTTP/streamable) MCP servers are supported.
 *
 * This is server-side MCP. `LlmAgent`'s `McpToolset` is the client-side form:
 * it opens the session here and runs the tools here. The shared idea is the
 * `headerProvider` contract.
 *
 * Mirrors `RemoteMcpServer` in google/adk-python `tools/_remote_mcp_server.py`,
 * which models it as a validated pydantic model. TypeScript rejects an unknown
 * property on an object literal at compile time, which covers the same mistake,
 * and a plain interface keeps this module free of any runtime import.
 */
export interface RemoteMcpServer {
  /**
   * Full URL of the remote MCP server endpoint, e.g.
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional server label. */
  name?: string;

  /**
   * Static headers sent on every turn, e.g. a fixed API key. Merged with
   * {@link headerProvider} output, which wins on a key conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the backend may call. */
  allowedTools?: string[];

  /** Mints headers per turn. See {@link McpHeaderProvider}. */
  headerProvider?: McpHeaderProvider;
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
