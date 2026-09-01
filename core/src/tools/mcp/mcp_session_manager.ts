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
import type {Stream, Writable} from 'node:stream';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

import {createRecordingFetch, getHttpDebugSink} from './http_debug_recorder.js';

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

/** The `name` carried by every {@link McpConnectionError}. */
export const MCP_CONNECTION_ERROR_NAME = 'McpConnectionError';

/**
 * Raised when an MCP operation fails, naming the operation that failed.
 *
 * The original failure is kept as `cause`, so a caller can still inspect the
 * transport error underneath the contextual message.
 */
export class McpConnectionError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = MCP_CONNECTION_ERROR_NAME;
  }
}

/**
 * Handles a `sampling/createMessage` request from the MCP server: the server
 * asks this client to run an inference on its behalf.
 */
export type McpSamplingCallback = (
  request: CreateMessageRequest['params'],
) => CreateMessageResult | Promise<CreateMessageResult>;

/**
 * Handles an `elicitation/create` request from the MCP server: the server asks
 * this client for a value from the user mid-call.
 */
export type McpElicitationCallback = (
  request: ElicitRequest['params'],
) => ElicitResult | Promise<ElicitResult>;

/** Optional configuration for an {@link MCPSessionManager}. */
export interface MCPSessionManagerOptions {
  /**
   * Stream that receives the MCP server's stderr and the transport errors of
   * every session this manager opens, including the ones an {@link MCPTool}
   * opens to run a tool. When omitted, transport errors go to `logger.error`
   * and a stdio server's stderr is inherited by the parent process.
   */
  errlog?: Writable;
  /**
   * The server-to-client callbacks to register on every session this manager
   * creates.
   *
   * A capability is declared to the server only when its callback is supplied,
   * so a server never asks for something this client cannot answer.
   */
  samplingCallback?: McpSamplingCallback;
  /** Extra detail for the declared `sampling` capability. */
  samplingCapabilities?: ClientCapabilities['sampling'];
  elicitationCallback?: McpElicitationCallback;
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

/** The header shapes `fetch` accepts, as the MCP transport declares them. */
type TransportHeaders = NonNullable<
  NonNullable<StreamableHTTPClientTransportOptions['requestInit']>['headers']
>;

/**
 * Merges per-session headers on top of the configured ones.
 *
 * `Headers` normalizes the three accepted shapes (record, entry list, and
 * `Headers`) into one, so the result is a plain record with lower-case names.
 *
 * @param configured The transport's own headers, if it has any.
 * @param extra The headers to apply on top.
 * @return The merged headers.
 */
function mergeHeaders(
  configured: TransportHeaders | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const headers = new Headers(configured);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  const merged: Record<string, string> = {};
  headers.forEach((value, name) => {
    merged[name] = value;
  });
  return merged;
}

/**
 * Returns `options` with a recording `fetch` installed, but only while a debug
 * sink is active. With no sink the caller's options are handed back untouched,
 * so an ordinary run sends exactly the bytes it sends today.
 */
function withHttpDebugRecording(
  options: StreamableHTTPClientTransportOptions,
): StreamableHTTPClientTransportOptions {
  const sink = getHttpDebugSink();
  if (!sink) {
    return options;
  }
  return {...options, fetch: createRecordingFetch(sink, options.fetch)};
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
  private readonly options: MCPSessionManagerOptions;
  /**
   * Active sessions, each mapped to the teardown for the resources that
   * outlive `client.close()` — currently the stderr pipe into `errlog`.
   */
  private readonly activeSessions = new Map<Client, (() => void) | undefined>();

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
   * @param options.headers Extra HTTP headers for this session, applied on top
   *     of the configured transport headers. An empty set is the same as none.
   *     Ignored by the stdio transport, which carries no headers. Header names
   *     are compared case-insensitively, so a per-session header replaces a
   *     configured one that differs only in case.
   * @return The connected client.
   */
  async createSession(
    options: {headers?: Record<string, string>} = {},
  ): Promise<Client> {
    const {errlog} = this.options;
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const capabilities = this.clientCapabilities();
    const client = capabilities
      ? new Client({name: 'MCPClient', version: '1.0.0'}, {capabilities})
      : new Client({name: 'MCPClient', version: '1.0.0'});
    await this.registerServerCallbacks(client);
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
          const configured = this.connectionParams.transportOptions ?? {};
          const requestInit =
            configured.requestInit ??
            (this.connectionParams.header !== undefined
              ? {
                  headers: this.connectionParams.header as Record<
                    string,
                    string
                  >,
                }
              : undefined);
          // Rebuilt rather than mutated: `configured` is the caller's object,
          // reused by every session, so per-session headers must not stick to
          // it.
          const transportOptions: StreamableHTTPClientTransportOptions = {
            ...configured,
            ...(requestInit === undefined ? {} : {requestInit}),
          };
          const {headers} = options;
          if (headers !== undefined && Object.keys(headers).length > 0) {
            transportOptions.requestInit = {
              ...requestInit,
              headers: mergeHeaders(requestInit?.headers, headers),
            };
          }

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            withHttpDebugRecording(transportOptions),
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

  /** The capabilities to declare, or `undefined` when there are none. */
  private clientCapabilities(): ClientCapabilities | undefined {
    const {samplingCallback, samplingCapabilities, elicitationCallback} =
      this.options;
    const capabilities: ClientCapabilities = {};
    if (samplingCallback) {
      capabilities.sampling = samplingCapabilities ?? {};
    }
    if (elicitationCallback) {
      capabilities.elicitation = {};
    }
    return samplingCallback || elicitationCallback ? capabilities : undefined;
  }

  /** Wires the configured callbacks to the requests the server sends back. */
  private async registerServerCallbacks(client: Client): Promise<void> {
    const {samplingCallback, elicitationCallback} = this.options;
    if (!samplingCallback && !elicitationCallback) {
      return;
    }

    // The schemas are needed as values, not as types, so this import has to
    // go through the optional peer loader like every other MCP SDK import.
    const {CreateMessageRequestSchema, ElicitRequestSchema} =
      await loadOptionalPeer(
        MCP_SDK,
        () => import('@modelcontextprotocol/sdk/types.js'),
      );

    if (samplingCallback) {
      client.setRequestHandler(CreateMessageRequestSchema, (request) =>
        samplingCallback(request.params),
      );
    }
    if (elicitationCallback) {
      client.setRequestHandler(ElicitRequestSchema, (request) =>
        elicitationCallback(request.params),
      );
    }
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
