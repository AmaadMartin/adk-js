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
 * What the MCP SDK reports once it stops trying to resume a dropped stream.
 *
 * Nearly every transport error a session survives arrives on the same channel:
 * a standalone event stream the server does not offer, one unparseable event,
 * a stream drop the SDK goes on to resume. Treating those as fatal would break
 * servers that work. This message is the exception. The SDK raises it from
 * `_scheduleReconnection`, having given up, and then does nothing further — so
 * the response never arrives and the request waits out its timeout.
 *
 * The other errors that do end a session need no help here: the SDK rethrows a
 * failed send to the caller, and rejects every in-flight request on close.
 */
const RECONNECTION_EXHAUSTED = 'Maximum reconnection attempts';

/** What the manager knows about the transport behind one session. */
interface TransportState {
  /** Rejects once the transport can no longer deliver a response. */
  readonly lost: Promise<never>;
  /** Rejects {@link TransportState.lost}. Called at most once. */
  readonly reportLost: (failure: Error) => void;
}

/** Tracks a session's transport, so a request can stop waiting on a dead one. */
function createTransportState(): TransportState {
  // The executor runs synchronously, so the rejecter is collected before the
  // promise is returned.
  const rejecters: Array<(failure: Error) => void> = [];
  const lost = new Promise<never>((_, reject) => rejecters.push(reject));
  // Most sessions never lose their transport, and a rejection nobody observed
  // would warn.
  lost.catch(() => {});
  const [reportLost] = rejecters;
  return {lost, reportLost};
}

/**
 * Logs a transport error, and ends the session if the transport cannot recover.
 *
 * Every error is logged, because a transport reports errors that no request is
 * waiting for and those would otherwise be dropped.
 */
function handleTransportError(state: TransportState, err: unknown): void {
  const description = formatError(err);
  logger.error('MCP transport error: ' + description);
  if (!description.includes(RECONNECTION_EXHAUSTED)) {
    return;
  }

  state.reportLost(
    new Error('MCP session connection lost: ' + description, {cause: err}),
  );
}

/**
 * Builds the transport options for one session, without writing anything back
 * into the connection parameters every session shares.
 *
 * Per-session headers win over the connection's static ones. `Headers.set`
 * does the merging, so `authorization` replaces `Authorization` rather than
 * arriving beside it as a second value.
 */
function buildTransportOptions(
  params: StreamableHTTPConnectionParams,
  sessionHeaders: Record<string, string> | undefined,
): StreamableHTTPClientTransportOptions {
  const options: StreamableHTTPClientTransportOptions = {
    ...params.transportOptions,
  };

  if (!options.requestInit && params.header !== undefined) {
    options.requestInit = {
      headers: params.header as Record<string, string>,
    };
  }

  if (!sessionHeaders || Object.keys(sessionHeaders).length === 0) {
    return options;
  }

  const merged = new Headers(options.requestInit?.headers);
  for (const [name, value] of Object.entries(sessionHeaders)) {
    merged.set(name, value);
  }
  const headers: Record<string, string> = {};
  merged.forEach((value, name) => {
    headers[name] = value;
  });
  options.requestInit = {...options.requestInit, headers};
  return options;
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
  private readonly activeSessions = new Set<Client>();
  private readonly transportStates = new Map<Client, TransportState>();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Opens a new MCP client session.
   *
   * @param options.headers Headers merged over the connection's static headers
   *     for this session only, so one invocation's credentials never reach the
   *     next. On a key conflict these win, whatever the letter case. Stdio
   *     connections carry no headers and ignore them.
   */
  async createSession(options?: {
    headers?: Record<string, string>;
  }): Promise<Client> {
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const client = new Client({name: 'MCPClient', version: '1.0.0'});
    const transportState = createTransportState();
    const onerror = (err: unknown) => {
      handleTransportError(transportState, err);
    };

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
          transport.onerror = onerror;
          await client.connect(transport);
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          const transportOptions = buildTransportOptions(
            this.connectionParams,
            options?.headers,
          );

          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            transportOptions,
          );
          transport.onerror = onerror;
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
    this.transportStates.set(client, transportState);
    return client;
  }

  /**
   * Runs a request on a session and abandons it if the transport dies first.
   *
   * The SDK covers most of this already: it rethrows a failed send, and
   * rejects every in-flight request when the transport closes. It does not
   * cover a dropped event stream it has stopped trying to resume — nothing
   * closes, so the request waits out the SDK's 60-second request timeout. That
   * one case is what this guards. A transport error the session survives is
   * left alone, because failing on one would break a server that works.
   *
   * A session this manager did not open, or one already closed, runs
   * unguarded: the manager holds no transport state for it.
   *
   * @param client The session the request runs on.
   * @param call The request, already in flight.
   * @return What the request returned.
   * @throws `MCP session connection lost: <error>` when the transport dies
   *     before the request settles, or has already died.
   */
  async runGuarded<T>(client: Client, call: Promise<T>): Promise<T> {
    const state = this.transportStates.get(client);
    // `race` subscribes to both, so the loser's later rejection is observed:
    // closing the session rejects a call the transport already gave up on.
    return state ? Promise.race([call, state.lost]) : call;
  }

  async closeSession(client: Client): Promise<void> {
    if (this.activeSessions.has(client)) {
      this.activeSessions.delete(client);
      this.transportStates.delete(client);
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions);
  }
}
