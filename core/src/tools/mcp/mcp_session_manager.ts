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
import {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {ErrorCode} from '@modelcontextprotocol/sdk/types.js';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
}

/**
 * Reports whether `err` is the MCP SDK's own request-timeout rejection. The
 * JSON-RPC error code is matched instead of the error class, so the check
 * still holds when two copies of the SDK share one runtime.
 */
function isRequestTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === ErrorCode.RequestTimeout
  );
}

/**
 * Defines the parameters for establishing a connection to an MCP server using
 * standard input/output (stdio). This is typically used for running MCP servers
 * as local child processes.
 */
export interface StdioConnectionParams {
  type: 'StdioConnectionParams';
  serverParams: StdioServerParameters;
  /**
   * Deadline in milliseconds for each MCP round trip: the `initialize`
   * handshake, every tool listing, every tool call and every resource read.
   * The MCP SDK's own request timeout applies when this is unset.
   *
   * adk-python expresses the same option in seconds. adk-js keeps
   * milliseconds, the unit every JavaScript timeout API and the MCP SDK
   * itself use.
   */
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
   * Deadline in milliseconds for each MCP round trip: the `initialize`
   * handshake, every tool listing, every tool call and every resource read.
   * The MCP SDK's own request timeout applies when this is unset.
   *
   * adk-python expresses the same option in seconds. adk-js keeps
   * milliseconds, the unit every JavaScript timeout API and the MCP SDK
   * itself use.
   */
  timeout?: number;
  /**
   * @deprecated
   * Has no effect. The MCP SDK exposes no SSE read deadline, neither on the
   * transport options nor on the request options, so nothing reads this.
   * Use `timeout` to bound a round trip.
   */
  sseReadTimeout?: number;
  /**
   * Whether to terminate the server-side session when the client session is
   * closed. Defaults to true, matching adk-python. Servers that issue no
   * session id are unaffected, because the transport then sends no request.
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
  /** Active sessions, each mapped to the transport to terminate on close. */
  private readonly activeSessions = new Map<
    Client,
    StreamableHTTPClientTransport | undefined
  >();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Request options carrying the configured deadline. Empty when none is
   * configured, which leaves the MCP SDK's own request timeout in force.
   */
  private requestOptions(): RequestOptions {
    const {timeout} = this.connectionParams;
    return timeout === undefined ? {} : {timeout};
  }

  /**
   * Runs one MCP round trip under the configured deadline.
   *
   * `call` receives the request options to forward to the client method. When
   * the deadline expires, the SDK's generic timeout rejection is replaced by
   * one that names `operation`, keeping the original error as its `cause`.
   * Every other rejection passes through untouched.
   */
  async withTimeout<T>(
    operation: string,
    call: (options: RequestOptions) => Promise<T>,
  ): Promise<T> {
    const {timeout} = this.connectionParams;
    try {
      return await call(this.requestOptions());
    } catch (err: unknown) {
      if (timeout !== undefined && isRequestTimeout(err)) {
        throw new Error(`MCP ${operation} timed out after ${timeout}ms`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  async createSession(): Promise<Client> {
    const client = new Client({name: 'MCPClient', version: '1.0.0'});
    let transportToTerminate: StreamableHTTPClientTransport | undefined;

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const transport = new StdioClientTransport(
            this.connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport, this.requestOptions());
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
          await client.connect(transport, this.requestOptions());

          if (this.connectionParams.terminateOnClose !== false) {
            transportToTerminate = transport;
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

    this.activeSessions.set(client, transportToTerminate);
    return client;
  }

  async closeSession(client: Client): Promise<void> {
    if (!this.activeSessions.has(client)) return;
    const transport = this.activeSessions.get(client);
    this.activeSessions.delete(client);

    if (transport) {
      try {
        // Must precede close(), which aborts the signal terminateSession uses.
        await transport.terminateSession();
      } catch (err) {
        logger.warn('Failed to terminate MCP session: ' + formatError(err));
      }
    }

    await client.close();
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions.keys());
  }
}
