/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
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
 *
 * One session is pooled and reused, so N operations against a server cost one
 * connection rather than N. The session therefore outlives a single operation
 * and belongs to whoever owns the manager: the owner must call
 * {@link closeSession} for every client {@link getActiveSessions} reports to
 * release the MCP server. `MCPToolset.close()` does this for a toolset.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;
  /**
   * The connect in flight or already settled. Held as the promise so that
   * concurrent `createSession()` calls share one connect instead of racing to
   * build two.
   */
  private pending?: Promise<Client>;
  /** The pooled client, once its connect resolved. */
  private pooled?: Client;

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Returns the pooled session, connecting a new one when the pool is empty.
   *
   * The returned client stays open until it is closed by {@link closeSession}
   * or by the peer. Callers must not close it themselves.
   */
  async createSession(): Promise<Client> {
    if (this.pending) {
      logger.debug('Reusing pooled MCP session');
      return this.pending;
    }

    const pending = this.connect();
    this.pending = pending;

    let client: Client;
    try {
      client = await pending;
    } catch (err) {
      if (this.pending === pending) {
        this.pending = undefined;
      }
      throw err;
    }

    this.pooled = client;
    client.onclose = () => this.evict(client);
    logger.debug('Created new MCP session');
    return client;
  }

  private async connect(): Promise<Client> {
    const client = new Client({name: 'MCPClient', version: '1.0.0'});

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const transport = new StdioClientTransport(
            this.connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
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

          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            options,
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

    return client;
  }

  /** Drops a client that can no longer be used, so it is never handed out again. */
  private evict(client: Client): void {
    if (this.pooled === client) {
      this.pooled = undefined;
      this.pending = undefined;
    }
  }

  async closeSession(client: Client): Promise<void> {
    if (this.pooled === client) {
      this.evict(client);
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return this.pooled ? [this.pooled] : [];
  }
}
