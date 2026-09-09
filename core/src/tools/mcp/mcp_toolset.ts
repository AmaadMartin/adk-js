/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Writable} from 'node:stream';

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  BlobResourceContents,
  ClientCapabilities,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {formatError, isAbortError} from '../../utils/error_utils.js';
import {
  appendHttpDebugInfo,
  HttpExchange,
  runWithHttpDebugCapture,
} from '../../utils/http_debug_utils.js';
import {logger, LogLevel} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {RESERVED_TOOL_NAMES} from '../reserved_tool_names.js';

import {LoadMcpResourceTool} from './load_mcp_resource_tool.js';
import {
  createMcpAuthConfig,
  McpAuthOptions,
  resolveMcpHeaders,
} from './mcp_auth.js';
import {
  McpConnectionError,
  MCPConnectionParams,
  McpElicitationCallback,
  McpSamplingCallback,
  MCPSessionManager,
} from './mcp_session_manager.js';
import {
  McpProgressCallback,
  McpProgressCallbackFactory,
  MCPTool,
  RequireMcpConfirmation,
} from './mcp_tool.js';
import {
  McpToolsetConfig,
  resolveConfigConnectionParams,
} from './mcp_toolset_config.js';

/**
 * The hard ceiling on cached tool lists.
 *
 * A `headerProvider` that mints a fresh value per request would otherwise grow
 * the cache without bound while every entry is still unexpired.
 */
const MAX_TOOL_LIST_CACHE_ENTRIES = 64;

/** A `tools/list` response and the monotonic time it stops being usable. */
interface CachedToolList {
  tools: Tool[];
  expiresAt: number;
}

/** The optional behaviour of an {@link MCPToolset}. */
export interface McpToolsetOptions extends McpAuthOptions {
  /**
   * Whether the tools of this toolset need human approval before they run: a
   * flag, or a predicate over the call arguments and the tool context.
   */
  requireConfirmation?: boolean | RequireMcpConfirmation;

  /**
   * Reuse the MCP server's `tools/list` response for this many seconds instead
   * of listing on every `getTools()` call. Entries are keyed per header
   * identity, so one tenant never sees another's tool list.
   *
   * ADK does not subscribe to `notifications/tools/list_changed`, so a tool the
   * server adds or removes goes unnoticed until the entry expires. The cache
   * lives on this toolset instance, so sharing it means sharing the instance.
   *
   * Leave it unset to list on every call. A value of `0` or less throws.
   */
  toolListCacheTtlSeconds?: number;

  /**
   * Whether to expose the MCP server's resources to the agent, by appending a
   * `load_mcp_resource` tool. Defaults to false.
   */
  useMcpResources?: boolean;

  /** A progress callback shared by every tool of this toolset. */
  progressCallback?: McpProgressCallback;

  /** Builds a progress callback per tool call. */
  progressCallbackFactory?: McpProgressCallbackFactory;

  /** Answers a `sampling/createMessage` request from the MCP server. */
  samplingCallback?: McpSamplingCallback;

  /** Extra detail for the declared `sampling` capability. */
  samplingCapabilities?: ClientCapabilities['sampling'];

  /** Answers an `elicitation/create` request from the MCP server. */
  elicitationCallback?: McpElicitationCallback;

  /**
   * Stream that receives the MCP server's stderr and its transport errors, for
   * every session the toolset opens. adk-python defaults this to `sys.stderr`;
   * leaving it unset here sends transport errors to the ADK logger and lets a
   * stdio server's stderr be inherited by the parent process.
   */
  errlog?: Writable;
}

/**
 * Derives the cache key for a set of merged headers.
 *
 * adk-python keys on its session pool's key, because it pools sessions per
 * header identity. `MCPSessionManager` here builds a fresh client per call and
 * has no pool, so the key comes from the headers directly. Sorting the entries
 * keeps `{a, b}` and `{b, a}` on one key while two tenants stay apart.
 */
function toolListCacheKey(headers: Record<string, string>): string {
  return JSON.stringify(Object.entries(headers).sort());
}

/**
 * Orders two tools by name, by code point.
 *
 * Not `localeCompare`: a locale collation would order tool names differently
 * from adk-python's `sort(key=...)`, and the order is observable to the model.
 */
function compareByName(a: BaseTool, b: BaseTool): number {
  if (a.name < b.name) {
    return -1;
  }
  return a.name > b.name ? 1 : 0;
}

/**
 * Rejects when `call` outlives `timeoutSeconds`, and clears the timer on both
 * the success and the failure path.
 *
 * The rejection is a plain error rather than an `AbortError`, so the retry
 * treats an unresponsive server as a failure worth one more attempt. This
 * diverges from adk-python: there `asyncio.wait_for` raises a `TimeoutError`
 * whose context is a `CancelledError`, which `retry_on_errors` re-raises
 * without a second attempt. The cost of the divergence is one extra
 * connection, and up to twice the timeout, against a server that never
 * answers.
 */
function withTimeout<T>(call: Promise<T>, timeoutSeconds?: number): Promise<T> {
  if (timeoutSeconds === undefined) {
    return call;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP call timed out after ${timeoutSeconds}s.`)),
      timeoutSeconds * 1000,
    );
  });
  return Promise.race([call, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Names the MCP operation that produced `err`, so a bare transport string
 * reaches the caller as `<operation>: <root cause>`.
 *
 * A cancellation passes through untouched: the caller has to keep seeing an
 * `AbortError` rather than a connection failure. Everything else is wrapped,
 * as `mcp_toolset.py` wraps it.
 */
function nameFailedOperation(operation: string, err: unknown): unknown {
  if (isAbortError(err)) {
    return err;
  }
  return new McpConnectionError(`${operation}: ${formatError(err)}`, {
    cause: err,
  });
}

/**
 * A toolset that dynamically discovers and provides tools from a Model Context
 * Protocol (MCP) server.
 *
 * This class connects to an MCP server, retrieves the list of available tools,
 * and wraps each of them in an {@link MCPTool} instance. This allows the agent
 * to seamlessly use tools from an external MCP-compliant service.
 *
 * The toolset can be configured with a filter to selectively expose a subset
 * of the tools provided by the MCP server.
 *
 * It can also be configured with a prefix. If provided, all tools discovered
 * from the MCP server will have their names prefixed with `${prefix}_`. When the
 * LLM invokes the prefixed tool, this toolset transparently strips the prefix
 * before sending the request to the underlying MCP server.
 *
 * Usage:
 *   import { MCPToolset } from '@google/adk';
 *   import { StreamableHTTPConnectionParamsSchema } from '@google/adk';
 *
 *   const connectionParams = StreamableHTTPConnectionParamsSchema.parse({
 *     type: "StreamableHTTPConnectionParams",
 *     url: "http://localhost:8788/mcp"
 *   });
 *
 *   const mcpToolset = new MCPToolset(connectionParams);
 *   const tools = await mcpToolset.getTools();
 *
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly options: McpToolsetOptions;
  private readonly authConfig?: AuthConfig;
  private readonly params: MCPConnectionParams;
  /** Ordered least- to most-recently used, so the cap evicts from the front. */
  private readonly toolListCache = new Map<string, CachedToolList>();

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
    options: McpToolsetOptions = {},
  ) {
    super(toolFilter, prefix);

    if (!connectionParams) {
      throw new Error('Missing connection params in MCPToolset.');
    }
    const ttl = options.toolListCacheTtlSeconds;
    if (ttl !== undefined && ttl <= 0) {
      throw new Error(`toolListCacheTtlSeconds must be positive, got ${ttl}.`);
    }

    this.options = options;
    this.params = connectionParams;
    this.authConfig = createMcpAuthConfig(options);
    this.mcpSessionManager = new MCPSessionManager(connectionParams, {
      samplingCallback: options.samplingCallback,
      samplingCapabilities: options.samplingCapabilities,
      elicitationCallback: options.elicitationCallback,
      errlog: options.errlog,
    });
  }

  /**
   * Builds a toolset from a declarative configuration object, for a caller
   * that loads an agent from a file rather than writing it in code.
   *
   * A config that declares a stdio server is refused unless the host opts in,
   * because the config-supplied command runs as a local process.
   *
   * @param config The declared MCP server and its options.
   * @return The configured toolset.
   * @throws If the config does not declare exactly one connection param, if a
   *     params object contradicts the field it is declared under, or if the
   *     config declares a stdio server without the opt-in.
   */
  static fromConfig(config: McpToolsetConfig): MCPToolset {
    return new MCPToolset(
      resolveConfigConnectionParams(config),
      config.toolFilter ?? [],
      config.prefix,
      {
        toolListCacheTtlSeconds: config.toolListCacheTtlSeconds,
        authScheme: config.authScheme,
        authCredential: config.authCredential,
        credentialKey: config.credentialKey,
        useMcpResources: config.useMcpResources,
      },
    );
  }

  /** The connection params this toolset reaches its MCP server with. */
  get connectionParams(): MCPConnectionParams {
    return this.params;
  }

  /** The scheme the MCP server authenticates with, when one was configured. */
  get authScheme(): AuthScheme | undefined {
    return this.options.authScheme;
  }

  /** The raw credential configured for {@link MCPToolset.authScheme}. */
  get authCredential(): AuthCredential | undefined {
    return this.options.authCredential;
  }

  /**
   * The configured error stream, or `undefined` when there is none.
   *
   * adk-python defaults its `errlog` to `sys.stderr`. adk-js returns what the
   * caller configured, so `undefined` means "transport errors to the ADK
   * logger, a stdio server's stderr inherited".
   */
  get errlog(): Writable | undefined {
    return this.options.errlog;
  }

  /**
   * The auth config of this toolset, or `undefined` when no `authScheme` was
   * supplied.
   *
   * The same instance is returned every time: the host fills
   * `exchangedAuthCredential` on it in place before calling `getTools()`.
   */
  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  /**
   * Discovers the tools the MCP server advertises.
   *
   * A failed discovery is attempted once more, because the session it ran on
   * may simply have dropped; a second failure propagates. A cancelled call is
   * never retried.
   *
   * @param context The invocation the request belongs to. Used for the
   *     headers, the tool filter, and the HTTP debug capture.
   * @return The tools this toolset exposes, ordered by name.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    try {
      return await this.discoverTools(context);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        throw err;
      }
      logger.debug(`Retrying getTools due to error: ${formatError(err)}`);
      return this.discoverTools(context);
    }
  }

  /** One attempt at listing, filtering and wrapping the server's tools. */
  private async discoverTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers = await resolveMcpHeaders(
      this.authConfig,
      this.options.headerProvider,
      context,
    );

    let mcpTools = this.readToolListCache(headers);
    if (!mcpTools) {
      mcpTools = await this.listTools(headers, context);
      this.writeToolListCache(headers, mcpTools);
    }
    logger.debug(`number of tools: ${mcpTools.length}`);
    for (const tool of mcpTools) {
      logger.debug(`tool: ${tool.name}`);
    }

    if (!context && typeof this.toolFilter === 'function') {
      logger.warn(
        'MCPToolset: a ToolPredicate toolFilter was provided but getTools() ' +
          'was called without a ReadonlyContext. The filter will not be applied.',
      );
    }

    // Filtering runs on every call, cache hit or miss: the cache skips the
    // round trip, not the context-dependent filtering.
    const tools: BaseTool[] = mcpTools
      .filter((tool) => this.acceptToolName(tool))
      .map((tool) => this.createTool(tool))
      .filter((tool) => this.selectTool(tool, context));

    // A stable order across turns. The server's tools/list order is not
    // contractual, and an unstable one invalidates the model's context cache.
    tools.sort(compareByName);

    if (this.options.useMcpResources) {
      tools.push(new LoadMcpResourceTool(this));
    }
    return tools;
  }

  /**
   * Whether the exposed name of `tool` is free to use, warning when it is not.
   *
   * A server tool that adopts a framework tool name is dropped rather than
   * allowed through, so that one such name cannot take the server's honest
   * tools down with it.
   */
  private acceptToolName(tool: Tool): boolean {
    const name = this.prefix ? `${this.prefix}_${tool.name}` : tool.name;
    if (!RESERVED_TOOL_NAMES.has(name)) {
      return true;
    }
    logger.warn(
      `Skipping MCP tool '${name}' because it collides with a reserved ADK ` +
        'framework tool name.',
    );
    return false;
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @param context The invocation the request belongs to, used for headers.
   * @return The resource names available on the server.
   */
  async listResources(context?: ReadonlyContext): Promise<string[]> {
    const result = await this.listResourcesResult(context);
    return result.resources.map((resource) => resource.name);
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @param context The invocation the request belongs to, used for headers.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(
    name: string,
    context?: ReadonlyContext,
  ): Promise<Resource> {
    const result = await this.listResourcesResult(context);
    const resource = result.resources.find(
      (candidate) => candidate.name === name,
    );
    if (!resource) {
      throw new Error(`Resource with name '${name}' not found.`);
    }
    return resource;
  }

  /**
   * Reads the contents of the named resource from the MCP server.
   *
   * The resource name is resolved to a URI via {@link getResourceInfo} before
   * reading. Binary contents are returned base64-encoded, exactly as provided
   * by the server (never decoded and re-encoded).
   *
   * @param name The advertised name of the resource to read.
   * @param context The invocation the request belongs to, used for headers.
   * @return The resource contents (text and/or base64-encoded binary).
   * @throws If the resource is unknown or has no URI.
   */
  async readResource(
    name: string,
    context?: ReadonlyContext,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const resourceInfo = await this.getResourceInfo(name, context);
    if (!resourceInfo.uri) {
      throw new Error(`Resource '${name}' has no URI.`);
    }

    const result = await this.executeWithSession(
      `Failed to get resource ${name} from MCP server`,
      async (session) =>
        (await session.readResource({
          uri: resourceInfo.uri,
        })) as ReadResourceResult,
      context,
    );
    return result.contents;
  }

  async close(): Promise<void> {
    this.toolListCache.clear();
    const sessions = this.mcpSessionManager.getActiveSessions();
    const outcomes = await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // Logged, not rethrown: a session that will not close must not block
        // application shutdown.
        logger.warn(`Error during MCPToolset cleanup: ${outcome.reason}`);
      }
    }
  }

  /**
   * Opens a session, runs `call` on it under the configured timeout, and
   * closes the session again on every exit path.
   *
   * This is the single place a failed MCP call becomes an
   * {@link McpConnectionError}: `operation` names what was attempted, so the
   * caller learns which MCP call failed instead of reading a bare transport
   * string.
   *
   * @param operation Short description of the attempt, used as the message
   *     prefix on failure.
   * @param headers Headers to open the session with.
   * @param call Receives the open session.
   * @return Whatever `call` resolves to.
   * @throws {McpConnectionError} when opening the session, the call itself or
   *     the timeout fails. A cancellation propagates unchanged.
   */
  private async openSessionAndRun<T>(
    operation: string,
    headers: Record<string, string>,
    call: (session: Client) => Promise<T>,
  ): Promise<T> {
    let session: Client | undefined;
    try {
      session = await this.mcpSessionManager.createSession(headers);
      return await withTimeout(call(session), this.params.timeout);
    } catch (err: unknown) {
      throw nameFailedOperation(operation, err);
    } finally {
      if (session) {
        await this.mcpSessionManager.closeSession(session);
      }
    }
  }

  /**
   * Runs one MCP operation, capturing the HTTP exchanges behind it when debug
   * logging is on and the caller supplied a context to record them against.
   *
   * The capture wraps session creation as well as the call, so the
   * `initialize` handshake is recorded too. It is drained on the failure path
   * as well, which is when an operator most wants to read it.
   *
   * @param operation Short description of the attempt, used as the message
   *     prefix on failure.
   * @param call Receives the open session.
   * @param context The invocation to record the exchanges against.
   * @return Whatever `call` resolves to.
   */
  private async executeWithSession<T>(
    operation: string,
    call: (session: Client) => Promise<T>,
    context?: ReadonlyContext,
    headers?: Record<string, string>,
  ): Promise<T> {
    const resolvedHeaders =
      headers ??
      (await resolveMcpHeaders(
        this.authConfig,
        this.options.headerProvider,
        context,
      ));
    if (context === undefined || !logger.isEnabledFor(LogLevel.DEBUG)) {
      return this.openSessionAndRun(operation, resolvedHeaders, call);
    }
    const exchanges: HttpExchange[] = [];
    try {
      return await runWithHttpDebugCapture(exchanges, () =>
        this.openSessionAndRun(operation, resolvedHeaders, call),
      );
    } finally {
      appendHttpDebugInfo(context.invocationContext.customMetadata, exchanges);
    }
  }

  /** Fetches the server's tool list over a session of its own. */
  private async listTools(
    headers: Record<string, string>,
    context?: ReadonlyContext,
  ): Promise<Tool[]> {
    const result = await this.executeWithSession(
      'Failed to get tools from MCP server',
      async (session) => (await session.listTools()) as ListToolsResult,
      context,
      headers,
    );
    return result.tools;
  }

  /** Lists resources over a session of its own, closing it either way. */
  private listResourcesResult(
    context?: ReadonlyContext,
  ): Promise<ListResourcesResult> {
    return this.executeWithSession(
      'Failed to list resources from MCP server',
      async (session) => (await session.listResources()) as ListResourcesResult,
      context,
    );
  }

  /** Wraps one MCP tool definition, applying the prefix and the options. */
  private createTool(tool: Tool): MCPTool {
    const toolWithPrefix = {
      ...tool,
      name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
    };
    return new MCPTool(toolWithPrefix, this.mcpSessionManager, tool.name, {
      // The toolset's own instance, so a credential the host exchanges on it
      // before calling getTools() reaches every tool call.
      authConfig: this.authConfig,
      requireConfirmation: this.options.requireConfirmation,
      headerProvider: this.options.headerProvider,
      progressCallback: this.options.progressCallback,
      progressCallbackFactory: this.options.progressCallbackFactory,
    });
  }

  /**
   * Whether `tool` passes the configured filter.
   *
   * A predicate filter needs a context to evaluate. Without one it cannot run,
   * so the tool is kept; `getTools` warns once per call about that.
   */
  private selectTool(tool: MCPTool, context?: ReadonlyContext): boolean {
    if (context) {
      return this.isToolSelected(tool, context);
    }
    if (typeof this.toolFilter === 'function') {
      return true;
    }
    // A name filter needs no context, and an empty one selects everything.
    return this.toolFilter.length === 0 || this.toolFilter.includes(tool.name);
  }

  /** The unexpired cached tool list for these headers, if there is one. */
  private readToolListCache(
    headers: Record<string, string>,
  ): Tool[] | undefined {
    if (this.options.toolListCacheTtlSeconds === undefined) {
      return undefined;
    }
    const key = toolListCacheKey(headers);
    const entry = this.toolListCache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= performance.now()) {
      this.toolListCache.delete(key);
      return undefined;
    }
    // Re-inserting moves the key to the end, which is the most-recently-used
    // position a Map's insertion order gives for free.
    this.toolListCache.delete(key);
    this.toolListCache.set(key, entry);
    return entry.tools;
  }

  /** Caches a tool list for these headers, unless caching is off. */
  private writeToolListCache(
    headers: Record<string, string>,
    tools: Tool[],
  ): void {
    const ttlSeconds = this.options.toolListCacheTtlSeconds;
    if (ttlSeconds === undefined) {
      return;
    }

    // A read only evicts the key it was asked for, so a key that never comes
    // back is never reclaimed. Sweep what has expired here, then cap the rest.
    const now = performance.now();
    for (const [key, entry] of this.toolListCache) {
      if (entry.expiresAt <= now) {
        this.toolListCache.delete(key);
      }
    }

    const key = toolListCacheKey(headers);
    this.toolListCache.delete(key);
    this.toolListCache.set(key, {
      tools: [...tools],
      expiresAt: now + ttlSeconds * 1000,
    });

    while (this.toolListCache.size > MAX_TOOL_LIST_CACHE_ENTRIES) {
      const [oldest] = this.toolListCache.keys();
      this.toolListCache.delete(oldest);
    }
  }
}
