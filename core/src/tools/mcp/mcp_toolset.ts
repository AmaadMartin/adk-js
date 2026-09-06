/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Writable} from 'node:stream';

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {formatError, isAbortError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {
  McpConnectionError,
  MCPConnectionParams,
  MCPSessionManager,
} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

/** Optional configuration for an {@link MCPToolset}. */
export interface McpToolsetOptions {
  /**
   * Stream that receives the MCP server's stderr and its transport errors, for
   * every session the toolset opens — tool discovery, resource reads, and the
   * sessions its {@link MCPTool}s open to run a tool. When omitted, transport
   * errors go to the ADK logger and a stdio server's stderr is inherited by
   * the parent process.
   */
  errlog?: Writable;
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
 * Every method rejects with {@link McpConnectionError}, whose message names
 * the MCP operation that failed and whose `cause` is the original error. The
 * prefixes match adk-python's, so a log search works against either SDK:
 *
 * - `getTools`: `Failed to get tools from MCP server`
 * - `listResources`, `getResourceInfo`: `Failed to list resources from MCP server`
 * - `readResource`: `Failed to get resource <name> from MCP server`
 *
 * A cancelled call is the exception: an `AbortError` reaches the caller
 * unchanged, so "the caller gave up" stays distinguishable from "the server
 * broke".
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
    options: McpToolsetOptions = {},
  ) {
    super(toolFilter, prefix);
    this.mcpSessionManager = new MCPSessionManager(connectionParams, {
      errlog: options.errlog,
    });
  }

  /**
   * Opens a session, runs `operation` on it, and closes it again.
   *
   * This is the single place a failed MCP call is turned into an
   * {@link McpConnectionError}: `operation` names what was being attempted, so
   * the caller learns which MCP call failed instead of reading a bare
   * transport string. The session is closed on every exit path.
   *
   * @param operation Short description of the attempt, used as the message
   *   prefix on failure.
   * @param run Receives the open session.
   * @return Whatever `run` resolves to.
   * @throws {McpConnectionError} when opening the session or running `run`
   *   fails for any reason other than cancellation.
   */
  private async executeWithSession<T>(
    operation: string,
    run: (session: Client) => Promise<T>,
  ): Promise<T> {
    let session: Client | undefined;
    try {
      session = await this.mcpSessionManager.createSession();
      return await run(session);
    } catch (err: unknown) {
      throw nameFailedOperation(operation, err);
    } finally {
      if (session) {
        await this.mcpSessionManager.closeSession(session);
      }
    }
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const listResult = await this.executeWithSession(
      'Failed to get tools from MCP server',
      async (session) => (await session.listTools()) as ListToolsResult,
    );
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
    const result = await this.listResourcesResult();
    return result.resources.map((resource) => resource.name);
  }

  /** Fetches the server's resource listing, naming the operation on failure. */
  private listResourcesResult(): Promise<ListResourcesResult> {
    return this.executeWithSession(
      'Failed to list resources from MCP server',
      async (session) => (await session.listResources()) as ListResourcesResult,
    );
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const result = await this.listResourcesResult();

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

    const result = await this.executeWithSession(
      `Failed to get resource ${name} from MCP server`,
      async (session) =>
        (await session.readResource({
          uri: resourceInfo.uri,
        })) as ReadResourceResult,
    );
    return result.contents;
  }

  async close(): Promise<void> {
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
