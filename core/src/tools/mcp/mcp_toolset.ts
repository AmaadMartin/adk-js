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

import {RESERVED_TOOL_NAMES} from '../../agents/framework_function_calls.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
import {TtlLruCache} from '../../utils/ttl_lru_cache.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {RequireConfirmationPredicate} from '../tool_confirmation.js';

import {LoadMcpResourceTool} from './load_mcp_resource_tool.js';
import {
  ElicitationFn,
  MCPConnectionParams,
  MCPHeaderProvider,
  MCPSessionManager,
  SamplingFn,
} from './mcp_session_manager.js';
import {MCPTool, ProgressFn} from './mcp_tool.js';
import {
  McpToolsetConfig,
  resolveConfigConnectionParams,
} from './mcp_toolset_config.js';

/**
 * Configures an {@link MCPToolset}.
 *
 * Prefer this over the positional constructor when the toolset needs anything
 * beyond a connection, a filter and a prefix.
 */
export interface MCPToolsetOptions {
  /** How to reach the MCP server. */
  connectionParams: MCPConnectionParams;
  /** Selects the tools this toolset exposes. Defaults to no filter. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended as `${prefix}_` to every discovered tool name. */
  prefix?: string;
  /**
   * How long a `tools/list` response stays usable, in seconds. Omit to disable
   * caching; a value of zero or less is rejected.
   */
  toolListCacheTtlSeconds?: number;
  /** Whether a human must approve a tool call before it reaches the server. */
  requireConfirmation?: boolean | RequireConfirmationPredicate;
  /** Resolves extra request headers before each MCP session is created. */
  headerProvider?: MCPHeaderProvider;
  /** Receives progress notifications for every tool call. */
  progressCallback?: ProgressFn;
  /**
   * Adds {@link LoadMcpResourceTool} to the tool list, so the model can read
   * the resources the MCP server advertises. Defaults to false.
   */
  useMcpResources?: boolean;
  /** Handles a server's `sampling/createMessage` request. */
  samplingCallback?: SamplingFn;
  /** Detail advertised with the sampling capability. Defaults to `{}`. */
  samplingCapabilities?: ClientCapabilities['sampling'];
  /** Handles a server's `elicitation/create` request. */
  elicitationCallback?: ElicitationFn;
}

/**
 * The cap on cached tool lists, so a `headerProvider` that mints a fresh value
 * per request cannot grow the cache without bound while entries are still live.
 */
const MAX_TOOL_LIST_CACHE_ENTRIES = 64;

/**
 * Reads the options out of either constructor form.
 *
 * The forms are told apart by `connectionParams`: {@link MCPToolsetOptions}
 * always carries it and no `MCPConnectionParams` member does.
 *
 * @throws If the connection params are missing, or if the cache lifetime is
 *     not positive. TypeScript already rejects a call with no connection
 *     params, so that guard is for an untyped JavaScript caller.
 */
function normalizeToolsetOptions(
  optionsOrConnectionParams: MCPToolsetOptions | MCPConnectionParams,
  toolFilter: ToolPredicate | string[],
  prefix?: string,
): MCPToolsetOptions {
  const options =
    optionsOrConnectionParams && 'connectionParams' in optionsOrConnectionParams
      ? optionsOrConnectionParams
      : {connectionParams: optionsOrConnectionParams, toolFilter, prefix};

  if (!options.connectionParams) {
    throw new Error('Missing connection params in MCPToolset.');
  }
  if (
    options.toolListCacheTtlSeconds !== undefined &&
    options.toolListCacheTtlSeconds <= 0
  ) {
    throw new Error(
      'toolListCacheTtlSeconds must be positive. Omit it to disable caching.',
    );
  }
  return options;
}

/**
 * Returns a cache key that identifies one set of session headers.
 *
 * Headers are the only thing that varies session identity for a single
 * toolset, so a cached tool list is never served to a different identity.
 */
function toolListCacheKey(headers: Record<string, string>): string {
  return JSON.stringify(Object.entries(headers).sort());
}

/**
 * Returns the tools `filter` selects. An empty array means no filter.
 *
 * A {@link ToolPredicate} needs a context to evaluate; without one the filter
 * is skipped and a warning is logged.
 */
function applyToolFilter(
  tools: BaseTool[],
  filter: ToolPredicate | string[] | undefined,
  context?: ReadonlyContext,
): BaseTool[] {
  if (!filter || (Array.isArray(filter) && filter.length === 0)) {
    return tools;
  }

  if (Array.isArray(filter)) {
    const names = filter;
    return tools.filter((tool) => names.includes(tool.name));
  }

  if (context) {
    return tools.filter((tool) => filter(tool, context));
  }

  logger.warn(
    'MCPToolset: a ToolPredicate toolFilter was provided but getTools() ' +
      'was called without a ReadonlyContext. The filter will not be applied.',
  );
  return tools;
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
  private readonly useMcpResources: boolean;
  private readonly headerProvider?: MCPHeaderProvider;
  private readonly requireConfirmation: boolean | RequireConfirmationPredicate;
  private readonly progressCallback?: ProgressFn;
  private readonly toolListCache?: TtlLruCache<Tool[]>;

  constructor(options: MCPToolsetOptions);
  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter?: ToolPredicate | string[],
    prefix?: string,
  );
  constructor(
    optionsOrConnectionParams: MCPToolsetOptions | MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    const options = normalizeToolsetOptions(
      optionsOrConnectionParams,
      toolFilter,
      prefix,
    );
    super(options.toolFilter ?? [], options.prefix);
    this.mcpSessionManager = new MCPSessionManager(options.connectionParams, {
      samplingCallback: options.samplingCallback,
      samplingCapabilities: options.samplingCapabilities,
      elicitationCallback: options.elicitationCallback,
    });
    this.useMcpResources = options.useMcpResources ?? false;
    this.headerProvider = options.headerProvider;
    this.requireConfirmation = options.requireConfirmation ?? false;
    this.progressCallback = options.progressCallback;
    this.toolListCache = options.toolListCacheTtlSeconds
      ? new TtlLruCache<Tool[]>(
          options.toolListCacheTtlSeconds,
          MAX_TOOL_LIST_CACHE_ENTRIES,
        )
      : undefined;
  }

  /**
   * Builds a toolset from a plain configuration object.
   *
   * @param config The MCP server declaration.
   * @throws If `config` does not name exactly one connection param, or names a
   *     stdio server the application has not opted in to through
   *     {@link ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}.
   */
  static fromConfig(config: McpToolsetConfig): MCPToolset {
    return new MCPToolset({
      connectionParams: resolveConfigConnectionParams(config),
      toolFilter: config.toolFilter,
      prefix: config.prefix,
      toolListCacheTtlSeconds: config.toolListCacheTtlSeconds,
      useMcpResources: config.useMcpResources,
    });
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers = await this.buildHeaders(context);
    const descriptors = await this.listToolDescriptors(headers);

    const tools: BaseTool[] = [];
    for (const descriptor of descriptors) {
      // The reserved check reads the name the server advertised, before any
      // prefix, because that is the name that would shadow a framework tool.
      if (RESERVED_TOOL_NAMES.has(descriptor.name)) {
        logger.warn(
          `MCPToolset: skipping tool '${descriptor.name}' because that name ` +
            'is reserved by the ADK framework.',
        );
        continue;
      }
      tools.push(
        new MCPTool({
          mcpTool: {
            ...descriptor,
            name: this.prefix
              ? `${this.prefix}_${descriptor.name}`
              : descriptor.name,
          },
          mcpSessionManager: this.mcpSessionManager,
          originalName: descriptor.name,
          requireConfirmation: this.requireConfirmation,
          progressCallback: this.progressCallback,
          headerProvider: this.headerProvider,
        }),
      );
    }

    // Sorted for a stable order across turns: an MCP server's listing order is
    // not contractual, and a changing order invalidates the model's context
    // cache every turn.
    const selected = applyToolFilter(tools, this.toolFilter, context).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (!this.useMcpResources) {
      return selected;
    }
    // Appended after the sort so the resource tool is always last, and so a
    // toolFilter naming the server's tools cannot drop it.
    return [...selected, new LoadMcpResourceTool(this)];
  }

  /** Resolves the headers one MCP session is opened with. */
  private async buildHeaders(
    context?: ReadonlyContext,
  ): Promise<Record<string, string>> {
    return this.headerProvider ? await this.headerProvider(context) : {};
  }

  /**
   * Returns the tool descriptors the server advertises, over the cache when one
   * is configured. Only the round trip is cached; the tools themselves are
   * rebuilt on every call so the filter always runs.
   */
  private async listToolDescriptors(
    headers: Record<string, string>,
  ): Promise<Tool[]> {
    const cache = this.toolListCache;
    const cacheKey = cache && toolListCacheKey(headers);
    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const session = await this.mcpSessionManager.createSession(headers);
    let listResult: ListToolsResult;
    try {
      listResult = (await session.listTools()) as ListToolsResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
    logger.debug(`number of tools: ${listResult.tools.length}`);
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`);
    }

    if (cache && cacheKey) {
      cache.set(cacheKey, listResult.tools);
    }
    return listResult.tools;
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @return The resource names available on the server.
   */
  async listResources(): Promise<string[]> {
    const session = await this.mcpSessionManager.createSession(
      await this.buildHeaders(),
    );
    try {
      const result = (await session.listResources()) as ListResourcesResult;
      return result.resources.map((resource) => resource.name);
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const session = await this.mcpSessionManager.createSession(
      await this.buildHeaders(),
    );
    let result: ListResourcesResult;
    try {
      result = (await session.listResources()) as ListResourcesResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }

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
   * @return The resource contents (text and/or base64-encoded binary).
   * @throws If the resource is unknown or has no URI.
   */
  async readResource(
    name: string,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const resourceInfo = await this.getResourceInfo(name);
    if (!resourceInfo.uri) {
      throw new Error(`Resource '${name}' has no URI.`);
    }

    const session = await this.mcpSessionManager.createSession(
      await this.buildHeaders(),
    );
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
    this.toolListCache?.clear();
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
