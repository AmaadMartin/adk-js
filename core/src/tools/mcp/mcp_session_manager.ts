/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  SSEClientTransport,
  SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  RequestHandlerExtra,
  RequestOptions,
} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ElicitRequestSchema,
  ErrorCode,
  type ClientNotification,
  type ClientRequest,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/** Identifies ADK to every MCP server it connects to. */
const CLIENT_INFO = {name: 'MCPClient', version: '1.0.0'};

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
}

/** The MCP SDK constructors {@link MCPSessionManager} needs to open a session. */
interface McpSdkModules {
  Client: typeof Client;
  StdioClientTransport: typeof StdioClientTransport;
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
  SSEClientTransport: typeof SSEClientTransport;
}

let mcpSdkModules: Promise<McpSdkModules> | undefined;

async function importMcpSdk(): Promise<McpSdkModules> {
  const [client, stdio, streamableHttp, sse] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);

  return {
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
  };
}

/**
 * Loads the MCP SDK on first use.
 *
 * Evaluating the client and its three transports costs roughly 0.3s, and a
 * process that imports `@google/adk` without ever opening an MCP session must
 * not pay it. The memo stores the promise, so concurrent callers share one
 * load.
 */
function loadMcpSdk(): Promise<McpSdkModules> {
  return (mcpSdkModules ??= importMcpSdk());
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
 * Defines the parameters for establishing a connection to an MCP server over
 * the HTTP+SSE transport, where the server streams messages on a long-lived
 * GET and the client posts messages back on a separate endpoint.
 *
 * Prefer {@link StreamableHTTPConnectionParams} for servers that support it;
 * these params exist for servers that only expose HTTP+SSE.
 *
 * Usage:
 *  const connectionParams: SseConnectionParams = {
 *    type: 'SseConnectionParams',
 *    url: 'http://localhost:8788/sse'
 *  };
 */
export interface SseConnectionParams {
  type: 'SseConnectionParams';
  url: string;
  transportOptions?: SSEClientTransportOptions;
}

/**
 * A union of all supported MCP connection parameter types.
 */
export type MCPConnectionParams =
  StdioConnectionParams | StreamableHTTPConnectionParams | SseConnectionParams;

/**
 * Handles a server-initiated `elicitation/create` request.
 *
 * The MCP SDK validates the request before the callback sees it and validates
 * the returned result before it goes back to the server, so the callback only
 * has to decide what to answer: `accept` (optionally with `content`), `decline`
 * or `cancel`. An error thrown by the callback is returned to the server as a
 * JSON-RPC error.
 */
export type ElicitationCallback = (
  request: ElicitRequest,
  extra: RequestHandlerExtra<ClientRequest, ClientNotification>,
) => ElicitResult | Promise<ElicitResult>;

/** Optional behaviour shared by every MCP client session ADK opens. */
export interface MCPSessionOptions {
  /**
   * Handles server-initiated `elicitation/create` requests, including URL-mode
   * elicitations used for out-of-band flows such as auth challenges.
   *
   * When supplied, the client advertises form- and URL-mode elicitation
   * support; when omitted, no elicitation capability is advertised.
   */
  elicitationCallback?: ElicitationCallback;
}

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
  private readonly elicitationCallback?: ElicitationCallback;

  constructor(
    connectionParams: MCPConnectionParams,
    options?: MCPSessionOptions,
  ) {
    this.connectionParams = connectionParams;
    this.elicitationCallback = options?.elicitationCallback;
  }

  /**
   * The configured deadline in milliseconds, or `undefined` when there is
   * none. The HTTP+SSE params declare no deadline, so they always report
   * `undefined`.
   */
  private get timeout(): number | undefined {
    return 'timeout' in this.connectionParams
      ? this.connectionParams.timeout
      : undefined;
  }

  /**
   * Request options carrying the configured deadline. Empty when none is
   * configured, which leaves the MCP SDK's own request timeout in force.
   */
  private requestOptions(): RequestOptions {
    const {timeout} = this;
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
    const {timeout} = this;
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
    const {
      Client,
      StdioClientTransport,
      StreamableHTTPClientTransport,
      SSEClientTransport,
    } = await loadMcpSdk();
    // The elicitation capability must be declared at construction: the SDK
    // rejects `setRequestHandler(ElicitRequestSchema, ...)` without it, and
    // capabilities can no longer be registered once the client is connected.
    const client = this.elicitationCallback
      ? new Client(CLIENT_INFO, {
          capabilities: {elicitation: {form: {}, url: {}}},
        })
      : new Client(CLIENT_INFO);
    let transportToTerminate: StreamableHTTPClientTransport | undefined;

    try {
      if (this.elicitationCallback) {
        client.setRequestHandler(ElicitRequestSchema, this.elicitationCallback);
      }
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
        case 'SseConnectionParams': {
          const transport = new SSEClientTransport(
            new URL(this.connectionParams.url),
            this.connectionParams.transportOptions,
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
