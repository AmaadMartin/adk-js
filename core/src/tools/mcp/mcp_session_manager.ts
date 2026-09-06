/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type {Stream, Writable} from 'node:stream';

import {formatError} from '../../utils/error_utils.js';
import {
  describeHttpExchange,
  headersToRecord,
  isCapturingHttpDebug,
  recordHttpExchange,
} from '../../utils/http_debug_utils.js';
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
 * Raised when an MCP operation fails, naming the operation that failed.
 *
 * The original failure is kept as `cause`, so a caller can still inspect the
 * transport error underneath the contextual message.
 */
export class McpConnectionError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
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

/**
 * Wraps `baseFetch` so that each exchange it performs is recorded.
 *
 * Installed only while a capture is open, so a session opened outside one
 * keeps the caller's transport options untouched. A caller-supplied `fetch` is
 * called, never replaced.
 */
function recordingFetch(baseFetch?: FetchLike): FetchLike {
  const doFetch: FetchLike = baseFetch ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const response = await doFetch(url, init);
    const request = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    recordHttpExchange(await describeHttpExchange(request, response));
    return response;
  };
}

/** The header shape the streamable HTTP transport accepts. */
type TransportHeaders = NonNullable<
  StreamableHTTPClientTransportOptions['requestInit']
>['headers'];

/**
 * Merges `extra` over `base`, whatever shape `base` came in as.
 *
 * `Headers` accepts every spelling and lower-cases the names, so a header set
 * in `transportOptions` and the same header set per request collide instead of
 * being sent twice.
 */
function mergeHeaders(
  base: TransportHeaders,
  extra: Record<string, string>,
): Record<string, string> {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return headersToRecord(headers);
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

/**
 * The server-to-client callbacks an {@link MCPSessionManager} registers on
 * every session it creates.
 *
 * A capability is declared to the server only when its callback is supplied, so
 * a server never asks for something this client cannot answer.
 */
export interface MCPSessionManagerOptions {
  samplingCallback?: McpSamplingCallback;
  /** Extra detail for the declared `sampling` capability. */
  samplingCapabilities?: ClientCapabilities['sampling'];
  elicitationCallback?: McpElicitationCallback;

  /**
   * Stream that receives the MCP server's stderr and the transport errors of
   * every session this manager opens. When omitted, transport errors go to the
   * ADK logger and a stdio server's stderr is inherited by the parent process.
   *
   * Setting it overrides `StdioServerParameters.stderr`, which has to become
   * `'pipe'` for the manager to read the stream at all.
   */
  errlog?: Writable;
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
   * How long one MCP call may take, in seconds — the unit adk-python uses.
   * A call that outlives it rejects. Unset means no bound.
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
   * How long one MCP call may take, in seconds — the unit adk-python uses.
   * A call that outlives it rejects. Unset means no bound.
   */
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
   * Opens a new MCP session.
   *
   * @param headers Headers to send on every request of this session. An empty
   *     set is the same as none. They are meaningless for a stdio transport and
   *     are ignored there.
   * @return The connected client.
   */
  async createSession(headers?: Record<string, string>): Promise<Client> {
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
    let detachStderr: (() => void) | undefined;

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
            detachStderr = pipeStderr(transport.stderr, errlog);
          }
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          // A copy, not the caller's object: two sessions built from the same
          // params must not inherit each other's per-request headers.
          const options: StreamableHTTPClientTransportOptions = {
            ...this.connectionParams.transportOptions,
          };

          if (
            !options.requestInit &&
            this.connectionParams.header !== undefined
          ) {
            options.requestInit = {
              headers: this.connectionParams.header as Record<string, string>,
            };
          }

          if (headers && Object.keys(headers).length > 0) {
            options.requestInit = {
              ...options.requestInit,
              headers: mergeHeaders(options.requestInit?.headers, headers),
            };
          }
          if (isCapturingHttpDebug()) {
            options.fetch = recordingFetch(options.fetch);
          }

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            options,
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

    this.activeSessions.set(client, detachStderr);
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
      const detachStderr = this.activeSessions.get(client);
      this.activeSessions.delete(client);
      detachStderr?.();
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions.keys());
  }
}
