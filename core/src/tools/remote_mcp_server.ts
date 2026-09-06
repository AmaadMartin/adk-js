/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `import type` keeps this module a leaf at runtime: a program that imports
// `tools/` before `agents/` must not pull the agent tree in through here.
import type {ReadonlyContext} from '../agents/readonly_context.js';

/**
 * Mints headers for one remote MCP turn, from the invocation that asked for
 * it. Use it to carry a token that must be fresh on every turn.
 */
export type McpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/** The options a {@link RemoteMcpServer} is built from. */
export interface RemoteMcpServerParams {
  /**
   * Full URL of the remote MCP server endpoint, for example
   * `https://api.example.com/mcp`.
   */
  url: string;

  /** Optional server label. */
  name?: string;

  /**
   * Static headers sent on every turn, for example a fixed API key. Merged
   * with {@link RemoteMcpServerParams.headerProvider} output, which wins on a
   * key conflict.
   */
  headers?: Record<string, string>;

  /** Restricts which of the server's tools the backend may call. */
  allowedTools?: string[];

  /** Runtime callback that mints headers at request time, once per turn. */
  headerProvider?: McpHeaderProvider;
}

/**
 * A unique symbol to identify remote MCP server specs.
 * Defined once and shared by all RemoteMcpServer instances.
 */
const REMOTE_MCP_SERVER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.remoteMcpServer',
);

/**
 * Type guard to check if an object is an instance of RemoteMcpServer.
 * @param obj The object to check.
 * @returns True if the object is a RemoteMcpServer, false otherwise.
 */
export function isRemoteMcpServer(obj: unknown): obj is RemoteMcpServer {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    REMOTE_MCP_SERVER_SIGNATURE_SYMBOL in obj &&
    obj[REMOTE_MCP_SERVER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A remote MCP server that the Managed Agents API runs server-side.
 *
 * The caller describes the endpoint; `ManagedAgent` forwards its URL and
 * headers to the Interactions API, and the backend opens the Model Context
 * Protocol session and runs the tools. Only remote (HTTP or streamable) MCP
 * servers work here.
 *
 * This is server-side MCP. `McpToolset` is the client-side counterpart: it
 * opens the session itself and runs the tools in this process. ADK never
 * connects to the server described here.
 *
 * Ports `RemoteMcpServer` in google/adk-python
 * `tools/_remote_mcp_server.py`.
 */
export class RemoteMcpServer {
  /** A unique symbol to identify a remote MCP server spec. */
  readonly [REMOTE_MCP_SERVER_SIGNATURE_SYMBOL] = true;

  readonly url: string;
  readonly name?: string;
  readonly headers?: Record<string, string>;
  readonly allowedTools?: string[];
  readonly headerProvider?: McpHeaderProvider;

  constructor(params: RemoteMcpServerParams) {
    if (!params.url) {
      throw new Error('RemoteMcpServer requires a non-empty url.');
    }
    this.url = params.url;
    this.name = params.name;
    this.headers = params.headers;
    this.allowedTools = params.allowedTools;
    this.headerProvider = params.headerProvider;
  }
}
