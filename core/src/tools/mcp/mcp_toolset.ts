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
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {LoadMcpResourceTool} from './load_mcp_resource_tool.js';
import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';
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
   * Adds {@link LoadMcpResourceTool} to the tool list, so the model can read
   * the resources the MCP server advertises. Defaults to false.
   */
  useMcpResources?: boolean;
}

/**
 * Reads the options out of either constructor form.
 *
 * The forms are told apart by `connectionParams`: {@link MCPToolsetOptions}
 * always carries it and no `MCPConnectionParams` member does.
 *
 * @throws If the connection params are missing.
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
  return options;
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
    this.mcpSessionManager = new MCPSessionManager(options.connectionParams);
    this.useMcpResources = options.useMcpResources ?? false;
  }

  /**
   * Builds a toolset from a plain configuration object.
   *
   * @param config The MCP server declaration.
   * @throws If `config` does not name exactly one connection param, or names a
   *     stdio server the application has not opted in to. See
   *     {@link setAllowConfigStdioMcpServers}.
   */
  static fromConfig(config: McpToolsetConfig): MCPToolset {
    return new MCPToolset({
      connectionParams: resolveConfigConnectionParams(config),
      toolFilter: config.toolFilter,
      prefix: config.prefix,
      useMcpResources: config.useMcpResources,
    });
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const session = await this.mcpSessionManager.createSession();

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

    const tools = listResult.tools.map((tool) => {
      // Create a cloned tool definition with the prefixed name
      const toolWithPrefix = {
        ...tool,
        name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      };
      return new MCPTool(toolWithPrefix, this.mcpSessionManager, tool.name);
    });

    const selected = applyToolFilter(tools, this.toolFilter, context);
    if (!this.useMcpResources) {
      return selected;
    }
    // Appended after the filter so the resource tool is always last, and so a
    // toolFilter naming the server's tools cannot drop it.
    return [...selected, new LoadMcpResourceTool(this)];
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
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
