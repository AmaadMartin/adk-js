/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Stream, Writable} from 'node:stream';

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

/**
 * Raised when an MCP operation fails, naming the operation that failed.
 *
 * The original failure is kept as `cause`, so a caller can still inspect the
 * transport error underneath the contextual message.
 */
export class McpConnectionError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
}

/** Optional configuration for an {@link MCPSessionManager}. */
export interface MCPSessionManagerOptions {
  /**
   * Stream that receives the MCP server's stderr and the transport errors of
   * every session this manager opens, including the ones an {@link MCPTool}
   * opens to run a tool. When omitted, transport errors go to `logger.error`
   * and a stdio server's stderr is inherited by the parent process.
   */
  errlog?: Writable;
}

/**
 * Surfaces a background transport error that would otherwise be dropped.
 * Writes to `errlog` when the caller supplied one, and to the ADK logger
 * otherwise.
 */
function logTransportError(err: unknown, errlog?: Writable): void {
  const message = 'MCP transport error: ' + formatError(err);
  if (errlog) {
    errlog.write(message + '\n');
    return;
  }
  logger.error(message);
}

/**
 * Forwards a stdio server's stderr into `errlog`, and returns the teardown
 * that stops forwarding. A long-lived manager opens one session per call, so
 * the listener has to come off again when the session closes.
 *
 * Returns `undefined` when the transport exposes no stderr, which is what a
 * transport does unless `StdioServerParameters.stderr` asked for a pipe.
 */
function pipeStderr(
  stderr: Stream | null,
  errlog: Writable,
): (() => void) | undefined {
  if (!stderr) {
    return undefined;
  }
  const forward = (chunk: string | Uint8Array) => {
    errlog.write(chunk);
  };
  stderr.on('data', forward);
  return () => {
    stderr.off('data', forward);
  };
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
  /**
   * Active sessions, each mapped to the teardown for the resources that
   * outlive `client.close()` — currently the stderr pipe into `errlog`.
   */
  private readonly activeSessions = new Map<Client, (() => void) | undefined>();
  private readonly errlog?: Writable;

  constructor(
    connectionParams: MCPConnectionParams,
    options: MCPSessionManagerOptions = {},
  ) {
    this.connectionParams = connectionParams;
    this.errlog = options.errlog;
  }

  async createSession(): Promise<Client> {
    const {errlog} = this;
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const client = new Client({name: 'MCPClient', version: '1.0.0'});
    let detach: (() => void) | undefined;

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const {StdioClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/stdio.js'),
          );
          const transport = new StdioClientTransport(
            errlog
              ? {...this.connectionParams.serverParams, stderr: 'pipe'}
              : this.connectionParams.serverParams,
          );
          transport.onerror = (err) => logTransportError(err, errlog);
          await client.connect(transport);
          if (errlog) {
            detach = pipeStderr(transport.stderr, errlog);
          }
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          const options = this.connectionParams.transportOptions ?? {};

          if (
            !options.requestInit &&
            this.connectionParams.header !== undefined
          ) {
            options.requestInit = {
              headers: this.connectionParams.header as Record<string, string>,
            };
          }

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            options,
          );
          transport.onerror = (err) => logTransportError(err, errlog);
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

    this.activeSessions.set(client, detach);
    return client;
  }

  async closeSession(client: Client): Promise<void> {
    if (this.activeSessions.has(client)) {
      const detach = this.activeSessions.get(client);
      this.activeSessions.delete(client);
      detach?.();
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions.keys());
  }
}
