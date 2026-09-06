/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ReadonlyContext} from '../agents/readonly_context.js';

/**
 * Mints the headers of one remote MCP turn.
 *
 * Use it for a credential that must be fresh on every turn, such as a bearer
 * token. It receives the context of the turn and returns the headers, either
 * directly or as a promise.
 */
export type RemoteMcpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * A remote Model Context Protocol (MCP) server that the Managed Agents API
 * runs server-side.
 *
 * ADK forwards the URL and the headers to the Interactions API. The backend
 * opens the MCP session and runs the tools. Only a remote (HTTP or streamable
 * HTTP) MCP server works here.
 *
 * This is server-side MCP. `McpToolset` is the client-side counterpart: it
 * opens the session in this process and runs the tools here. ADK never
 * connects to the server described by this interface. The two share only the
 * header-provider contract.
 */
export interface RemoteMcpServer {
  /**
   * Full URL of the remote MCP server endpoint, for example
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional label for the server. */
  name?: string;

  /**
   * Static headers sent on every turn, such as a fixed API key. They merge
   * with the {@link RemoteMcpServer.headerProvider} output, which wins on a
   * key conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the model can call. */
  allowedTools?: string[];

  /** Mints headers at request time, once per turn. */
  headerProvider?: RemoteMcpHeaderProvider;
}

/**
 * Merges the static headers of a remote MCP server with the output of its
 * header provider, for one turn.
 *
 * The static headers are copied first, then the provider output is assigned
 * over the copy, so the provider wins on a key conflict. The copy keeps the
 * description's own `headers` object unchanged. An error from the provider
 * propagates: a failed token mint must be loud, not a silently missing header.
 *
 * @param server The server description.
 * @param context The context of the turn the headers are minted for.
 * @return The headers to send. Empty when the server declares none.
 */
export async function resolveRemoteMcpServerHeaders(
  server: RemoteMcpServer,
  context: ReadonlyContext,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {...server.headers};
  if (server.headerProvider !== undefined) {
    Object.assign(headers, await server.headerProvider(context));
  }
  return headers;
}
