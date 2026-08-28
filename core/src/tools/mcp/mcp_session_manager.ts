/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

/**
 * The optional peer backing every MCP connection.
 *
 * `@modelcontextprotocol/sdk` is the single largest transitive dependency
 * ADK ever pulled in, and it is only reachable through the MCP tools, so it
 * is loaded lazily from {@link MCPSessionManager.createSession}.
 */
const MCP_SDK: OptionalPeer = {
  packageName: '@modelcontextprotocol/sdk',
  feature: 'MCPSessionManager (and the MCP tools built on it)',
};

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
}

/**
 * Builds the transport options for one session, without writing anything back
 * into the connection parameters every session shares.
 *
 * Per-session headers win over the connection's static ones. `Headers.set`
 * does the merging, so `authorization` replaces `Authorization` rather than
 * arriving beside it as a second value.
 */
function buildTransportOptions(
  params: StreamableHTTPConnectionParams,
  sessionHeaders: Record<string, string> | undefined,
): StreamableHTTPClientTransportOptions {
  const options: StreamableHTTPClientTransportOptions = {
    ...params.transportOptions,
  };

  if (!options.requestInit && params.header !== undefined) {
    options.requestInit = {
      headers: params.header as Record<string, string>,
    };
  }

  if (!sessionHeaders || Object.keys(sessionHeaders).length === 0) {
    return options;
  }

  const merged = new Headers(options.requestInit?.headers);
  for (const [name, value] of Object.entries(sessionHeaders)) {
    merged.set(name, value);
  }
  const headers: Record<string, string> = {};
  merged.forEach((value, name) => {
    headers[name] = value;
  });
  options.requestInit = {...options.requestInit, headers};
  return options;
}

/**
 * Defines the parameters for establishing a connection to an MCP server using
 * standard input/output (stdio). This is typically used for running MCP servers
 * as local child processes.
 */
export interface StdioConnectionParams {
  type: 'StdioConnectionParams';
  serverParams: StdioServerParameters;
  timeout?: number;
}

/**
 * Defines the parameters for establishing a connection to an MCP server over
 * HTTP using Server-Sent Events (SSE) for streaming.
 *
 * Usage:
 *  const connectionParams: StreamableHTTPConnectionParams = {
 *    type: 'StreamableHTTPConnectionParams',
 *    url: 'http://localhost:8788/mcp'
 *  };
 */
export interface StreamableHTTPConnectionParams {
  type: 'StreamableHTTPConnectionParams';
  url: string;
  /**
   * @deprecated
   * Use transportOptions.requestInit.headers instead.
   * This field will be ignored if transportOptions is provided even if no headers are specified in transportOptions.
   */
  header?: Record<string, unknown>;
  timeout?: number;
  sseReadTimeout?: number;
  terminateOnClose?: boolean;
  transportOptions?: StreamableHTTPClientTransportOptions;
}

/**
 * A union of all supported MCP connection parameter types.
 */
export type MCPConnectionParams =
  | StdioConnectionParams
  | StreamableHTTPConnectionParams;

/**
 * Manages Model Context Protocol (MCP) client sessions.
 *
 * This class is responsible for establishing and managing connections to MCP
 * servers. It supports different transport protocols like Standard I/O (Stdio)
 * and Server-Sent Events (SSE) over HTTP, determined by the provided
 * connection parameters.
 *
 * The primary purpose of this manager is to abstract away the details of
 * session creation and connection handling, providing a simple interface for
 * creating new MCP client instances that can be used to interact with
 * remote tools.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;
  private readonly activeSessions = new Set<Client>();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Opens a new MCP client session.
   *
   * @param options.headers Headers merged over the connection's static headers
   *     for this session only, so one invocation's credentials never reach the
   *     next. On a key conflict these win, whatever the letter case. Stdio
   *     connections carry no headers and ignore them.
   */
  async createSession(options?: {
    headers?: Record<string, string>;
  }): Promise<Client> {
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const client = new Client({name: 'MCPClient', version: '1.0.0'});

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const {StdioClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/stdio.js'),
          );
          const transport = new StdioClientTransport(
            this.connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          const transportOptions = buildTransportOptions(
            this.connectionParams,
            options?.headers,
          );

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            transportOptions,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        default: {
          // Triggers compile error if a case is missing.
          const _exhaustiveCheck: never = this.connectionParams;
          break;
        }
      }
    } catch (err) {
      throw new Error('Failed to create MCP session: ' + formatError(err), {
        cause: err,
      });
    }

    this.activeSessions.add(client);
    return client;
  }

  async closeSession(client: Client): Promise<void> {
    if (this.activeSessions.has(client)) {
      this.activeSessions.delete(client);
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions);
  }
}
