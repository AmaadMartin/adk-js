/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {
  CallToolRequest,
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {authCredentialToHeaders} from '../../auth/credential_header_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Authentication for the MCP server behind an {@link MCPTool}.
 *
 * Auth happens only when `authScheme` is set. A credential given without a
 * scheme is ignored.
 */
export interface MCPToolAuthOptions {
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;

  /**
   * The credential to start from. An OAuth2 credential is exchanged for an
   * access token; the client is asked to supply one when this is omitted.
   */
  authCredential?: AuthCredential;

  /**
   * Namespaces the credential this tool requests and caches. Defaults to
   * `mcp_${authScheme.type}`, so all tools from one MCP server share one
   * credential instead of prompting per tool.
   */
  credentialKey?: string;
}

/**
 * Represents a tool exposed via the Model Context Protocol (MCP).
 *
 * This class acts as a wrapper around a tool definition received from an MCP
 * server. It translates the MCP tool's schema into a format compatible with
 * the Gemini AI platform (FunctionDeclaration) and handles the remote
 * execution of the tool by communicating with the MCP server through an
 * {@link MCPSessionManager}.
 *
 * When an LLM decides to call this tool, the `runAsync` method will be
 * invoked, which in turn establishes an MCP session, sends a `callTool`
 * request with the provided arguments, and returns the result from the
 * remote tool.
 *
 * The originalName parameter allows the tool to track the native tool name
 * exposed by the MCP server. This is critical when the toolset applies a
 * prefix to tool names (e.g., for LLM namespace disambiguation), ensuring
 * the correct original name is used when executing on the server.
 *
 * When {@link MCPToolAuthOptions} declare an auth scheme, the tool resolves a
 * credential for every call and sends it as a request header. Only the
 * StreamableHTTP transport carries headers; a stdio server never sees them.
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;
  private readonly authScheme?: AuthScheme;
  private readonly authCredential?: AuthCredential;
  private readonly credentialKey?: string;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    options: MCPToolAuthOptions = {},
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.credentialKey =
      options.credentialKey ??
      (options.authScheme ? `mcp_${options.authScheme.type}` : undefined);
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.mcpTool.name,
      description: this.mcpTool.description,
      parameters: toGeminiSchema(this.mcpTool.inputSchema),
      // TODO: need revisit, refer to this
      // https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result
      response: toGeminiSchema(this.mcpTool.outputSchema),
    };
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    let authHeaders: Record<string, string> | undefined;

    if (this.authScheme) {
      const authHandler = ToolAuthHandler.fromToolContext(
        request.toolContext,
        this.authScheme,
        this.authCredential,
        {credentialKey: this.credentialKey},
      );
      const authResult = await authHandler.prepareAuthCredentials();
      if (authResult.state === 'pending') {
        return {
          pending: true,
          message: 'Needs your authorization to access your data.',
        };
      }
      authHeaders = authCredentialToHeaders(
        authResult.authCredential,
        this.authScheme,
      );
    }

    const session = await this.mcpSessionManager.createSession(authHeaders);

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: request.args};
      const result = await session.callTool(callRequest.params, undefined, {
        signal: request.toolContext.abortSignal,
      });
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }
}
