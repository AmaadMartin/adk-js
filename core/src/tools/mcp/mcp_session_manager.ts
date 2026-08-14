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
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  type ClientCapabilities,
  type ClientNotification,
  type ClientRequest,
  type CreateMessageRequest,
  type CreateMessageResult,
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

/**
 * Handles a server-initiated `sampling/createMessage` request.
 *
 * The MCP SDK validates the request before the callback sees it and validates
 * the returned result before it goes back to the server, so the callback only
 * has to run the completion and return the message. An error thrown by the
 * callback is returned to the server as a JSON-RPC error.
 */
export type SamplingCallback = (
  request: CreateMessageRequest,
  extra: RequestHandlerExtra<ClientRequest, ClientNotification>,
) => CreateMessageResult | Promise<CreateMessageResult>;

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

  /**
   * Runs an LLM completion on behalf of the MCP server when it sends
   * `sampling/createMessage`. When omitted, no sampling capability is
   * advertised and the server's request is refused by the SDK.
   */
  samplingCallback?: SamplingCallback;

  /**
   * Widens the advertised sampling capability. Defaults to `{}` — plain
   * sampling — whenever `samplingCallback` is supplied. Declare `{tools: {}}`
   * only if the callback can honour `tools`/`toolChoice`, and `{context: {}}`
   * only if it honours `includeContext`; the SDK validates the reply against
   * the stricter schema once those are declared. Ignored without a callback.
   */
  samplingCapabilities?: ClientCapabilities['sampling'];
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
  private readonly samplingCallback?: SamplingCallback;
  private readonly samplingCapabilities?: ClientCapabilities['sampling'];

  constructor(
    connectionParams: MCPConnectionParams,
    options?: MCPSessionOptions,
  ) {
    this.connectionParams = connectionParams;
    this.elicitationCallback = options?.elicitationCallback;
    this.samplingCallback = options?.samplingCallback;
    this.samplingCapabilities = options?.samplingCapabilities;
  }

  /**
   * Declares only the capabilities that a supplied callback can answer.
   *
   * Returns `undefined` when there is nothing to declare, so a session without
   * callbacks builds the client from a single argument, exactly as it did
   * before these options existed.
   */
  private declaredCapabilities(): ClientCapabilities | undefined {
    const capabilities: ClientCapabilities = {};
    if (this.elicitationCallback) {
      capabilities.elicitation = {form: {}, url: {}};
    }
    if (this.samplingCallback) {
      capabilities.sampling = this.samplingCapabilities ?? {};
    }
    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  }

  async createSession(): Promise<Client> {
    // Capabilities must be declared at construction: the SDK rejects
    // `setRequestHandler` for a capability the client never advertised, and
    // capabilities can no longer be registered once the client is connected.
    const capabilities = this.declaredCapabilities();
    const client = capabilities
      ? new Client(CLIENT_INFO, {capabilities})
      : new Client(CLIENT_INFO);

    try {
      if (this.elicitationCallback) {
        client.setRequestHandler(ElicitRequestSchema, this.elicitationCallback);
      }
      if (this.samplingCallback) {
        client.setRequestHandler(
          CreateMessageRequestSchema,
          this.samplingCallback,
        );
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
