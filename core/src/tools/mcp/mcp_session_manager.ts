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
import {withStreamIdleTimeout} from '../../utils/fetch_utils.js';
import {logger} from '../../utils/logger.js';

const MS_PER_SECOND = 1000;

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
}

/**
 * Converts a timeout in seconds to milliseconds. Returns `undefined` for an
 * unset or non-positive value, which leaves the corresponding mechanism off.
 */
function toMillis(seconds: number | undefined): number | undefined {
  return typeof seconds === 'number' && seconds > 0
    ? seconds * MS_PER_SECOND
    : undefined;
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
  /**
   * Deadline in **seconds** for establishing the session, i.e. for the
   * `initialize` request. It does not bound later tool calls. Unset, zero and
   * negative values keep the MCP SDK default of 60 seconds.
   */
  timeout?: number;
  /**
   * Maximum idle gap in **seconds** between two chunks of a streamed
   * (`text/event-stream`) response. The budget restarts on every chunk. Unset,
   * zero and negative values leave a stalled stream unbounded.
   */
  sseReadTimeout?: number;
  /**
   * Sends an HTTP `DELETE` for the MCP session when the client closes, so the
   * server can release it immediately.
   *
   * This defaults to off, while adk-python's `terminate_on_close` defaults to
   * `True`. A session is created and closed per tool listing and per tool
   * call, so defaulting it on would add an HTTP request to each of those for
   * every existing caller.
   */
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
  /** Sessions whose server side must be terminated when the client closes. */
  private readonly transportsToTerminate = new Map<
    Client,
    StreamableHTTPClientTransport
  >();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  async createSession(): Promise<Client> {
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
          const params = this.connectionParams;
          const options: StreamableHTTPClientTransportOptions = {
            ...params.transportOptions,
          };

          if (!options.requestInit && params.header !== undefined) {
            options.requestInit = {
              headers: params.header as Record<string, string>,
            };
          }

          const idleTimeoutMs = toMillis(params.sseReadTimeout);
          if (idleTimeoutMs !== undefined) {
            options.fetch = withStreamIdleTimeout(idleTimeoutMs, options.fetch);
          }

          const transport = new StreamableHTTPClientTransport(
            new URL(params.url),
            options,
          );
          transport.onerror = logTransportError;

          const connectTimeoutMs = toMillis(params.timeout);
          await client.connect(
            transport,
            connectTimeoutMs === undefined
              ? undefined
              : {timeout: connectTimeoutMs},
          );

          if (params.terminateOnClose) {
            this.transportsToTerminate.set(client, transport);
          }
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

      const transport = this.transportsToTerminate.get(client);
      if (transport) {
        this.transportsToTerminate.delete(client);
        try {
          await transport.terminateSession();
        } catch (err) {
          logger.warn('Failed to terminate MCP session: ' + formatError(err));
        }
      }

      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions);
  }
}
