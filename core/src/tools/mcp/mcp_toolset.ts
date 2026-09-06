/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
import {AuthConfig} from '../../auth/auth_tool.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {LoadMcpResourceTool} from './load_mcp_resource_tool.js';
import {
  createMcpAuthConfig,
  McpAuthOptions,
  resolveMcpHeaders,
} from './mcp_auth.js';
import {
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
    this.authConfig = createMcpAuthConfig(options);
    this.mcpSessionManager = new MCPSessionManager(connectionParams, {
      samplingCallback: options.samplingCallback,
      samplingCapabilities: options.samplingCapabilities,
      elicitationCallback: options.elicitationCallback,
    });
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

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers = await resolveMcpHeaders(
      this.authConfig,
      this.options.headerProvider,
      context,
    );

    let mcpTools = this.readToolListCache(headers);
    if (!mcpTools) {
      mcpTools = await this.listTools(headers);
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

    const session = await this.createSession(context);
    try {
      const result = (await session.readResource({
        uri: resourceInfo.uri,
      })) as ReadResourceResult;
      return result.contents;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
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

  /** Opens a session carrying the headers this invocation resolves to. */
  private async createSession(context?: ReadonlyContext) {
    const headers = await resolveMcpHeaders(
      this.authConfig,
      this.options.headerProvider,
      context,
    );
    return this.mcpSessionManager.createSession(headers);
  }

  /** Fetches the server's tool list over a session of its own. */
  private async listTools(headers: Record<string, string>): Promise<Tool[]> {
    const session = await this.mcpSessionManager.createSession(headers);
    try {
      const result = (await session.listTools()) as ListToolsResult;
      return result.tools;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /** Lists resources over a session of its own, closing it either way. */
  private async listResourcesResult(
    context?: ReadonlyContext,
  ): Promise<ListResourcesResult> {
    const session = await this.createSession(context);
    try {
      return (await session.listResources()) as ListResourcesResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
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
