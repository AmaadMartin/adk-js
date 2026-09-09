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

/** The request options the StreamableHTTP transport is configured with. */
type TransportRequestInit = NonNullable<
  StreamableHTTPClientTransportOptions['requestInit']
>;

/**
 * Flattens any header shape the transport accepts into a plain record.
 *
 * A `Headers` instance and an entry array both spread to nonsense, so a
 * caller that used either would lose its headers the moment ADK merged one in.
 * A record is copied as it stands, which keeps the caller's capitalization.
 *
 * @param headers The configured headers, in any of the three shapes.
 * @return The equivalent record, or `undefined` when there are none.
 */
function toHeaderRecord(
  headers?: TransportRequestInit['headers'],
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  // A `Headers` instance keeps its entries behind an iterator rather than on
  // the object, so it is recognised by its method instead of by `instanceof`,
  // which fails across two copies of a package in one runtime.
  if (typeof (headers as Headers).forEach === 'function') {
    const record: Record<string, string> = {};
    (headers as Headers).forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  return {...(headers as Record<string, string>)};
}

/**
 * Combines the headers configured on a connection with per-call headers.
 *
 * Per-call headers win over configured ones of the same name, so a credential
 * resolved for the current invocation replaces a stale static value.
 *
 * @param params The connection the session is created for.
 * @param additionalHeaders Headers for this one call, such as the ones
 *   carrying a resolved credential.
 * @return The headers to send, or `undefined` when there are none and when the
 *   transport is stdio, which carries no headers at all.
 */
export function mergeConnectionHeaders(
  params: MCPConnectionParams,
  additionalHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  if (params.type !== 'StreamableHTTPConnectionParams') {
    return undefined;
  }

  const requestInit = params.transportOptions?.requestInit;
  const configured = requestInit
    ? toHeaderRecord(requestInit.headers)
    : toHeaderRecord(params.header as Record<string, string> | undefined);

  const merged = {...configured, ...additionalHeaders};
  return Object.keys(merged).length > 0 ? merged : undefined;
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

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Opens a new MCP session.
   *
   * @param headers Headers for this session only, merged over the ones the
   *   connection was configured with. Ignored by the stdio transport.
   * @return A connected MCP client.
   */
  async createSession(headers?: Record<string, string>): Promise<Client> {
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
          const mergedHeaders = mergeConnectionHeaders(
            this.connectionParams,
            headers,
          );
          // Built fresh rather than mutated in place: the caller owns
          // `transportOptions`, and writing this call's credential into it
          // would leak that credential into every later call.
          const options: StreamableHTTPClientTransportOptions = {
            ...this.connectionParams.transportOptions,
            ...(mergedHeaders
              ? {
                  requestInit: {
                    ...this.connectionParams.transportOptions?.requestInit,
                    headers: mergedHeaders,
                  },
                }
              : {}),
          };

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
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
