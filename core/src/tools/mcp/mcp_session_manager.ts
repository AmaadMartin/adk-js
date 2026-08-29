/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
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
 * Resolves extra request headers immediately before a session is opened.
 *
 * It runs for every session, so a short-lived credential is freshly minted each
 * time. Headers only apply to an HTTP transport; a stdio connection ignores
 * them.
 */
export type MCPHeaderProvider = (
  context?: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * Answers a server's `sampling/createMessage` request, which asks the client to
 * run a model on the server's behalf.
 */
export type SamplingFn = (
  request: CreateMessageRequest,
) => CreateMessageResult | Promise<CreateMessageResult>;

/**
 * Answers a server's `elicitation/create` request, which asks the client for
 * more input from the user.
 */
export type ElicitationFn = (
  request: ElicitRequest,
) => ElicitResult | Promise<ElicitResult>;

/** Configures the client an {@link MCPSessionManager} builds. */
export interface MCPSessionManagerOptions {
  /** Handles `sampling/createMessage`. Advertises the sampling capability. */
  samplingCallback?: SamplingFn;
  /** Detail advertised with the sampling capability. Defaults to `{}`. */
  samplingCapabilities?: ClientCapabilities['sampling'];
  /** Handles `elicitation/create`. Advertises the elicitation capability. */
  elicitationCallback?: ElicitationFn;
}

/**
 * Returns the capabilities the client declares at construction.
 *
 * The SDK refuses to register a request handler for a capability the client did
 * not declare, so this must be settled before `new Client`. Returns undefined
 * when neither callback is configured, so a client built without either option
 * is constructed exactly as before.
 */
function buildClientCapabilities(
  options: MCPSessionManagerOptions,
): ClientCapabilities | undefined {
  const capabilities: ClientCapabilities = {};
  if (options.samplingCallback) {
    capabilities.sampling = options.samplingCapabilities ?? {};
  }
  if (options.elicitationCallback) {
    capabilities.elicitation = {};
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

/**
 * Returns `connectionParams` with `extraHeaders` merged over its own headers,
 * folding in the deprecated `header` field.
 *
 * The stored params are never mutated: one manager serves many sessions and
 * each may carry different headers. Stdio has no headers, so it comes back
 * unchanged.
 */
function withExtraHeaders(
  connectionParams: MCPConnectionParams,
  extraHeaders?: Record<string, string>,
): MCPConnectionParams {
  if (connectionParams.type !== 'StreamableHTTPConnectionParams') {
    return connectionParams;
  }

  const transportOptions = connectionParams.transportOptions;
  // The deprecated `header` field is ignored whenever transportOptions is set,
  // even when it names no headers.
  const baseHeaders = transportOptions
    ? transportOptions.requestInit?.headers
    : (connectionParams.header as Record<string, string> | undefined);
  const headers = {...baseHeaders, ...extraHeaders};

  if (Object.keys(headers).length === 0) {
    return connectionParams;
  }

  return {
    ...connectionParams,
    transportOptions: {
      ...transportOptions,
      requestInit: {...transportOptions?.requestInit, headers},
    },
  };
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
  private readonly options: MCPSessionManagerOptions;
  private readonly activeSessions = new Set<Client>();

  constructor(
    connectionParams: MCPConnectionParams,
    options: MCPSessionManagerOptions = {},
  ) {
    this.connectionParams = connectionParams;
    this.options = options;
  }

  /**
   * Opens a new MCP client session.
   *
   * @param extraHeaders Headers merged over the connection's own headers for
   *     this session only; on a key conflict these win. Ignored for a stdio
   *     connection, which has no headers.
   */
  async createSession(extraHeaders?: Record<string, string>): Promise<Client> {
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const clientInfo = {name: 'MCPClient', version: '1.0.0'};
    const capabilities = buildClientCapabilities(this.options);
    // Constructed with no options at all when nothing is advertised, so a
    // client built without either callback is exactly what it was before.
    const client = capabilities
      ? new Client(clientInfo, {capabilities})
      : new Client(clientInfo);
    await this.registerRequestHandlers(client);

    const connectionParams = withExtraHeaders(
      this.connectionParams,
      extraHeaders,
    );

    try {
      switch (connectionParams.type) {
        case 'StdioConnectionParams': {
          const {StdioClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/stdio.js'),
          );
          const transport = new StdioClientTransport(
            connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          // withExtraHeaders already folded the deprecated `header` field in.
          const options = connectionParams.transportOptions ?? {};

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(connectionParams.url),
            options,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        default: {
          // Triggers compile error if a case is missing.
          const _exhaustiveCheck: never = connectionParams;
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

  /**
   * Registers the handlers for the capabilities this manager advertises.
   *
   * The request schemas are SDK values, so they are loaded lazily here rather
   * than imported at module top level: that would make the optional peer a hard
   * dependency for every ADK user.
   */
  private async registerRequestHandlers(client: Client): Promise<void> {
    const {samplingCallback, elicitationCallback} = this.options;
    if (!samplingCallback && !elicitationCallback) {
      return;
    }

    const {CreateMessageRequestSchema, ElicitRequestSchema} =
      await loadOptionalPeer(
        MCP_SDK,
        () => import('@modelcontextprotocol/sdk/types.js'),
      );

    if (samplingCallback) {
      client.setRequestHandler(CreateMessageRequestSchema, (request) =>
        samplingCallback(request),
      );
    }
    if (elicitationCallback) {
      client.setRequestHandler(ElicitRequestSchema, (request) =>
        elicitationCallback(request),
      );
    }
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
