/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {
  MCPSessionManager,
  StreamableHTTPConnectionParams,
} from '../../tools/mcp/mcp_session_manager.js';
import {MCPTool} from '../../tools/mcp/mcp_tool.js';
import {GCP_MCP_SERVER_DESTINATION_ID} from './types.js';

/**
 * A specialized BaseToolset subclass designed to represent a single registered MCP server.
 *
 * Unlike a standard MCPToolset, this class:
 * 1. Supports a dynamic `headerProvider` to fetch/refresh authorization and custom headers
 *    immediately before establishing the MCP connection session.
 * 2. Automatically injects the special `gcp.mcp.server.destination.id` telemetry metadata
 *    identifier into all resolved tools' custom metadata, allowing downstream execute_tool
 *    traces to be correctly attributed.
 */
export class AgentRegistrySingleMCPToolset extends BaseToolset {
  readonly destinationResourceId?: string;
  readonly connectionParams: StreamableHTTPConnectionParams;
  readonly headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
  readonly authScheme?: AuthScheme;
  readonly authCredential?: AuthCredential;
  /**
   * The manager whose pooled session the resolved tools share, kept with the
   * header signature it was built for.
   */
  private sessionManager?: {signature: string; manager: MCPSessionManager};

  /**
   * @param options - Configuration for the MCP toolset.
   * @param options.destinationResourceId - Telemetry identifier injected as
   *   `gcp.mcp.server.destination.id` into each resolved tool's custom metadata.
   * @param options.connectionParams - HTTP connection parameters for the MCP server.
   * @param options.toolFilter - Optional predicate or list of tool names to include.
   *   When omitted, all tools from the server are returned.
   * @param options.prefix - Optional prefix prepended to each tool name (e.g. `myServer_toolName`).
   * @param options.headerProvider - Optional async function called immediately before each
   *   {@link getTools} invocation to supply or refresh request headers (e.g. GCP auth tokens).
   * @param options.authScheme - Optional auth scheme forwarded to each resolved tool.
   * @param options.authCredential - Optional credential forwarded to each resolved tool.
   */
  constructor(options: {
    destinationResourceId?: string;
    connectionParams: StreamableHTTPConnectionParams;
    toolFilter?: ToolPredicate | string[];
    prefix?: string;
    headerProvider?: (
      context?: ReadonlyContext,
    ) => Promise<Record<string, string>> | Record<string, string>;
    authScheme?: AuthScheme;
    authCredential?: AuthCredential;
  }) {
    super(options.toolFilter || [], options.prefix);
    this.destinationResourceId = options.destinationResourceId;
    this.connectionParams = options.connectionParams;
    this.headerProvider = options.headerProvider;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
  }

  /**
   * Connects to the underlying MCP server, retrieves tool definitions, prefixes
   * tool names, and injects destination telemetry metadata into each tool.
   *
   * The `headerProvider`, if configured, is invoked immediately before the
   * connection is established so that tokens are always fresh.
   *
   * @param context - Optional readonly agent context passed to the header provider.
   * @returns The resolved and optionally filtered list of {@link MCPTool} instances.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers: Record<string, string> = {};

    // Resolve dynamic headers from the header provider (e.g., refreshing GCP tokens)
    if (this.headerProvider) {
      const providerHeaders = await this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    // Merge resolved headers into transport request options
    const mergedHeaders = {
      ...this.connectionParams.transportOptions?.requestInit?.headers,
      ...headers,
    } as Record<string, string>;
    const connectionParamsCopy: StreamableHTTPConnectionParams = {
      ...this.connectionParams,
      transportOptions: {
        ...this.connectionParams.transportOptions,
        requestInit: {
          ...this.connectionParams.transportOptions?.requestInit,
          headers: mergedHeaders,
        },
      },
    };

    // Establish session using MCPSessionManager
    const sessionManager = await this.resolveSessionManager(
      connectionParamsCopy,
      mergedHeaders,
    );
    const session = await sessionManager.createSession();

    // Retrieve tools from the remote server. The session stays open: the tools
    // resolved below share it, and close() releases it.
    const listResult = (await session.listTools()) as ListToolsResult;

    // Map tool definitions to MCPTools
    const tools = listResult.tools.map((tool) => {
      const prefixedName = this.prefix
        ? `${this.prefix}_${tool.name}`
        : tool.name;
      const mcpTool = new MCPTool(
        {...tool, name: prefixedName},
        sessionManager,
        tool.name,
      );

      // Inject gcp.mcp.server.destination.id telemetry key for tracing tools execution
      const toolWithMetadata = mcpTool as unknown as {
        customMetadata?: Record<string, string>;
      };
      if (this.destinationResourceId) {
        if (!toolWithMetadata.customMetadata) {
          toolWithMetadata.customMetadata = {};
        }
        toolWithMetadata.customMetadata[GCP_MCP_SERVER_DESTINATION_ID] =
          this.destinationResourceId;
      }
      return mcpTool;
    });

    // Apply toolFilter selection when specified
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }

    return tools.filter((t) => this.isToolSelected(t, context!));
  }

  /**
   * Returns the manager whose pooled session the tools will share, reusing the
   * previous one while the resolved headers are unchanged. Refreshed headers
   * need a new connection, so the previous session is closed first.
   */
  private async resolveSessionManager(
    params: StreamableHTTPConnectionParams,
    headers: Record<string, string>,
  ): Promise<MCPSessionManager> {
    const signature = JSON.stringify(Object.entries(headers).sort());
    if (this.sessionManager?.signature === signature) {
      return this.sessionManager.manager;
    }

    await this.close();
    const manager = new MCPSessionManager(params);
    this.sessionManager = {signature, manager};
    return manager;
  }

  /** Closes the MCP session the resolved tools share. */
  async close(): Promise<void> {
    const manager = this.sessionManager?.manager;
    this.sessionManager = undefined;
    if (!manager) {
      return;
    }
    await Promise.allSettled(
      manager
        .getActiveSessions()
        .map((session) => manager.closeSession(session)),
    );
  }
}
