/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ElicitRequestSchema,
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
}

let mcpSdkModules: Promise<McpSdkModules> | undefined;

async function importMcpSdk(): Promise<McpSdkModules> {
  const [client, stdio, streamableHttp] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);

  return {
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
  };
}

/**
 * Loads the MCP SDK on first use.
 *
 * Evaluating the client and its two transports costs roughly 0.3s, and a
 * process that imports `@google/adk` without ever opening an MCP session must
 * not pay it. The memo stores the promise, so concurrent callers share one
 * load.
 */
function loadMcpSdk(): Promise<McpSdkModules> {
  return (mcpSdkModules ??= importMcpSdk());
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
  private readonly activeSessions = new Set<Client>();
  private readonly elicitationCallback?: ElicitationCallback;

  constructor(
    connectionParams: MCPConnectionParams,
    options?: MCPSessionOptions,
  ) {
    this.connectionParams = connectionParams;
    this.elicitationCallback = options?.elicitationCallback;
  }

  async createSession(): Promise<Client> {
    const {Client, StdioClientTransport, StreamableHTTPClientTransport} =
      await loadMcpSdk();
    // The elicitation capability must be declared at construction: the SDK
    // rejects `setRequestHandler(ElicitRequestSchema, ...)` without it, and
    // capabilities can no longer be registered once the client is connected.
    const client = this.elicitationCallback
      ? new Client(CLIENT_INFO, {
          capabilities: {elicitation: {form: {}, url: {}}},
        })
      : new Client(CLIENT_INFO);

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
