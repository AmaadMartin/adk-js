/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

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
  private readonly toolListCacheTtlSeconds?: number;
  /** The last `tools/list` response and the epoch ms it stops being usable. */
  private cachedToolList?: {tools: Tool[]; expiresAt: number};

  /**
   * @param connectionParams How to reach the MCP server.
   * @param toolFilter Selects the tools this toolset exposes.
   * @param prefix Prepended as `${prefix}_` to every discovered tool name.
   * @param toolListCacheTtlSeconds If set, reuse the MCP server's `tools/list`
   *   response for this many seconds instead of listing on every
   *   {@link getTools} call. ADK does not subscribe to
   *   `notifications/tools/list_changed`, so a tool the server adds or removes
   *   goes unnoticed until the entry expires. The cache lives on this toolset
   *   instance, so sharing it means sharing the instance. Defaults to
   *   undefined, which lists on every call.
   * @throws If `toolListCacheTtlSeconds` is given and is not positive.
   */
  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
    toolListCacheTtlSeconds?: number,
  ) {
    super(toolFilter, prefix);
    // The negated comparison also rejects NaN.
    if (
      toolListCacheTtlSeconds !== undefined &&
      !(toolListCacheTtlSeconds > 0)
    ) {
      throw new Error(
        `toolListCacheTtlSeconds must be positive, got ${toolListCacheTtlSeconds}.`,
      );
    }
    this.toolListCacheTtlSeconds = toolListCacheTtlSeconds;
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const cached = this.cachedToolList;
    let mcpTools =
      cached && Date.now() < cached.expiresAt ? cached.tools : undefined;

    if (!mcpTools) {
      const session = await this.mcpSessionManager.createSession();

      let listResult: ListToolsResult;
      try {
        listResult = (await session.listTools()) as ListToolsResult;
      } finally {
        await this.mcpSessionManager.closeSession(session);
      }
      mcpTools = listResult.tools;
      if (this.toolListCacheTtlSeconds !== undefined) {
        this.cachedToolList = {
          tools: mcpTools,
          expiresAt: Date.now() + this.toolListCacheTtlSeconds * 1000,
        };
      }
    }
    logger.debug(`number of tools: ${mcpTools.length}`);
    for (const tool of mcpTools) {
      logger.debug(`tool: ${tool.name}`);
    }

    const tools = mcpTools.map((tool) => {
      // Create a cloned tool definition with the prefixed name
      const toolWithPrefix = {
        ...tool,
        name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      };
      return new MCPTool(toolWithPrefix, this.mcpSessionManager, tool.name);
    });

    // Apply toolFilter when specified.
    // An empty array (the default) means no filter — all tools are returned.
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }

    if (Array.isArray(filter)) {
      // String-array filter: match against the (possibly-prefixed) tool name.
      return tools.filter((tool) => (filter as string[]).includes(tool.name));
    }

    if (context) {
      // Predicate filter: requires a ReadonlyContext to evaluate.
      return tools.filter((tool) => filter(tool, context));
    }

    // Predicate filter requested but no context provided — return all tools
    // and log a warning so callers are aware the filter was not applied.
    logger.warn(
      'MCPToolset: a ToolPredicate toolFilter was provided but getTools() ' +
        'was called without a ReadonlyContext. The filter will not be applied.',
    );
    return tools;
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @return The resource names available on the server.
   */
  async listResources(): Promise<string[]> {
    const session = await this.mcpSessionManager.createSession();
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
    const session = await this.mcpSessionManager.createSession();
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

    const session = await this.mcpSessionManager.createSession();
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
    this.cachedToolList = undefined;
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
