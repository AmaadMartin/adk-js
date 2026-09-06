/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {toAuthHeaders} from '../../auth/auth_credential_utils.js';
import {
  AuthScheme,
  CustomAuthScheme,
  isCustomAuthScheme,
} from '../../auth/auth_schemes.js';
import {CustomAuthConfig} from '../../auth/auth_tool.js';
import {getCustomSchemeCredential} from '../../auth/credential_manager.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {
  MCPSessionManager,
  StreamableHTTPConnectionParams,
} from '../../tools/mcp/mcp_session_manager.js';
import {MCPTool} from '../../tools/mcp/mcp_tool.js';
import {logger} from '../../utils/logger.js';
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
  readonly authScheme?: AuthScheme | CustomAuthScheme;
  readonly authCredential?: AuthCredential;

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
   * @param options.authScheme - Optional auth scheme. A {@link CustomAuthScheme} is
   *   resolved through its registered auth provider before each connection.
   * @param options.authCredential - Optional raw credential handed to that provider.
   */
  constructor(options: {
    destinationResourceId?: string;
    connectionParams: StreamableHTTPConnectionParams;
    toolFilter?: ToolPredicate | string[];
    prefix?: string;
    headerProvider?: (
      context?: ReadonlyContext,
    ) => Promise<Record<string, string>> | Record<string, string>;
    authScheme?: AuthScheme | CustomAuthScheme;
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
   * Resolves a {@link CustomAuthScheme} into request headers through its
   * registered auth provider.
   *
   * A scheme with no registered provider, or a provider that fails to mint,
   * yields no headers and a warning naming the scheme type. Tool listing must
   * not fail on auth, matching how adk-python's toolset auth resolution treats
   * a credential-manager error.
   *
   * @returns The credential headers, or an empty record.
   */
  private async resolveAuthHeaders(
    context?: ReadonlyContext,
  ): Promise<Record<string, string>> {
    if (!this.authScheme || !isCustomAuthScheme(this.authScheme)) {
      return {};
    }

    const authConfig: CustomAuthConfig = {
      authScheme: this.authScheme,
      rawAuthCredential: this.authCredential,
      credentialKey: `${this.authScheme.type}_${
        this.destinationResourceId ?? this.prefix ?? 'default'
      }`,
    };

    try {
      return toAuthHeaders(
        await getCustomSchemeCredential(authConfig, context),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        `Failed to resolve the credential for auth scheme ${this.authScheme.type}: ${msg}`,
      );
      return {};
    }
  }

  /**
   * Connects to the underlying MCP server, retrieves tool definitions, prefixes
   * tool names, and injects destination telemetry metadata into each tool.
   *
   * The `headerProvider` and the auth provider, if configured, are invoked
   * immediately before the connection is established so that tokens are always
   * fresh. Credential headers take precedence over `headerProvider` headers.
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

    Object.assign(headers, await this.resolveAuthHeaders(context));

    // Merge resolved headers into transport request options
    const connectionParamsCopy: StreamableHTTPConnectionParams = {
      ...this.connectionParams,
      transportOptions: {
        ...this.connectionParams.transportOptions,
        requestInit: {
          ...this.connectionParams.transportOptions?.requestInit,
          headers: {
            ...this.connectionParams.transportOptions?.requestInit?.headers,
            ...headers,
          } as Record<string, string>,
        },
      },
    };

    // Establish session using MCPSessionManager
    const sessionManager = new MCPSessionManager(connectionParamsCopy);
    const session = await sessionManager.createSession();

    // Retrieve tools from the remote server and close the discovery session
    let listResult: ListToolsResult;
    try {
      listResult = (await session.listTools()) as ListToolsResult;
    } finally {
      await sessionManager.closeSession(session).catch((e) => {
        logger.warn('Failed to close MCP discovery session', e);
      });
    }

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

  async close(): Promise<void> {}
}
