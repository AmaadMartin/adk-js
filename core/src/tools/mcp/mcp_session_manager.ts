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

/**
 * Tears a server-side session down before its client is closed. Only a
 * streamable HTTP session has one; a stdio session has nothing to release.
 */
type SessionTerminator = () => Promise<void>;

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
  /**
   * Seconds to wait for the MCP server to complete the `initialize` handshake.
   * When unset, the MCP SDK's own 60s request timeout applies. `0` is a
   * zero-length budget, not "no limit".
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
   * Seconds to wait for the MCP server to complete the `initialize` handshake.
   * When unset, the MCP SDK's own 60s request timeout applies. `0` is a
   * zero-length budget, not "no limit".
   */
  timeout?: number;
  /**
   * Seconds to wait between reads on the Server-Sent Events (SSE) stream.
   *
   * Not currently applied: `StreamableHTTPClientTransportOptions` in the MCP
   * TypeScript SDK exposes no read-idle timeout to forward it to. The field is
   * kept for source compatibility, and for parity with the Python SDK, which
   * forwards it as the httpx read timeout.
   */
  sseReadTimeout?: number;
  /**
   * Whether closing this session also sends the MCP `DELETE` that terminates
   * the server-side session. Defaults to `true`.
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
  /**
   * Live sessions, each mapped to the teardown that must run before its client
   * is closed. A stdio session maps to `undefined`.
   */
  private readonly activeSessions = new Map<
    Client,
    SessionTerminator | undefined
  >();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  async createSession(): Promise<Client> {
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const client = new Client({name: 'MCPClient', version: '1.0.0'});
    let terminate: SessionTerminator | undefined;
    // The params carry seconds; `RequestOptions.timeout` is milliseconds.
    // Undefined leaves the SDK's own request timeout in force.
    const {timeout} = this.connectionParams;
    const requestOptions =
      timeout === undefined ? undefined : {timeout: timeout * 1000};

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
          await client.connect(transport, requestOptions);
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
          transport.onerror = logTransportError;
          await client.connect(transport, requestOptions);
          if (this.connectionParams.terminateOnClose ?? true) {
            terminate = async () => {
              // `terminateSession()` reports through `onerror` as well as
              // rejecting. `closeSession` awaits and logs the rejection, so
              // leaving the handler in place reports one failure twice, the
              // first time at error level for a teardown we deliberately
              // swallow.
              transport.onerror = undefined;
              await transport.terminateSession();
            };
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

    this.activeSessions.set(client, terminate);
    return client;
  }

  async closeSession(client: Client): Promise<void> {
    if (!this.activeSessions.has(client)) {
      return;
    }
    const terminate = this.activeSessions.get(client);
    this.activeSessions.delete(client);

    if (terminate) {
      // The DELETE is sent on the transport's abort signal, which
      // `client.close()` aborts, so it has to go first. A server that refuses
      // it must not mask the caller's own result: `closeSession` runs from a
      // `finally` block on every read path.
      try {
        await terminate();
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
