/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {Progress, Tool} from '@modelcontextprotocol/sdk/types.js';

import {Context} from '../../agents/context.js';
import {RESERVED_TOOL_NAMES} from '../../agents/framework_function_calls.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {credentialHeaders} from '../../auth/auth_header_utils.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/** A progress notification from a long-running MCP tool call. */
export type McpProgressCallback = (progress: Progress) => void | Promise<void>;

/** Builds a per-invocation progress callback from the runtime context. */
export type McpProgressCallbackFactory = (
  toolName: string,
  options: {callbackContext: Context},
) => McpProgressCallback | undefined;

/** Optional configuration for an {@link MCPTool}. */
export interface McpToolOptions {
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;
  /** The credential that satisfies {@link McpToolOptions.authScheme}. */
  authCredential?: AuthCredential;
  /** Key under which the resolved credential is cached in session state. */
  credentialKey?: string;
  /** Whether a human must approve the call before it runs. */
  requireConfirmation?:
    | boolean
    | ((
        args: Record<string, unknown>,
        toolContext: Context,
      ) => boolean | Promise<boolean>);
  /** Extra headers resolved per call, applied on top of the auth headers. */
  headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Receives the server's progress notifications for every call. */
  progressCallback?: McpProgressCallback;
  /** Builds a progress callback per call. Mutually exclusive with the above. */
  progressCallbackFactory?: McpProgressCallbackFactory;
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
 * {@link McpToolOptions} adds authentication, a human-approval gate, per-call
 * headers and progress notifications. With no options the call behaves exactly
 * as it did before those options existed.
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;
  private readonly options: McpToolOptions;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    options: McpToolOptions = {},
  ) {
    if (RESERVED_TOOL_NAMES.has(mcpTool.name)) {
      throw new Error(
        `MCP tool name '${mcpTool.name}' collides with a reserved ADK tool name.`,
      );
    }
    if (options.progressCallback && options.progressCallbackFactory) {
      throw new Error(
        'Configure either progressCallback or progressCallbackFactory, not both.',
      );
    }
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.options = options;
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

  /**
   * Whether this call is gated on human approval — the static flag, or the
   * predicate evaluated against the arguments.
   *
   * The resume path asks the same question a turn later, to check that an
   * approval it is about to honour belongs to a tool that gates at all. A gated
   * MCP call can only be approved because this override answers it.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    const requireConfirmation = this.options.requireConfirmation ?? false;
    if (typeof requireConfirmation !== 'function') {
      return requireConfirmation;
    }
    if (!toolContext) {
      throw new Error(
        `Tool '${this.name}' requires confirmation but no tool context was provided.`,
      );
    }
    return requireConfirmation(args, toolContext);
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const gate = await this.checkConfirmation(
      request.args,
      request.toolContext,
    );
    if (gate !== undefined) {
      return gate;
    }
    return this.callMcpTool(request);
  }

  /** Authenticates the call, opens a session, calls the tool and closes it. */
  private async callMcpTool(request: RunAsyncToolRequest): Promise<unknown> {
    const {toolContext} = request;
    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      this.options.authScheme,
      this.options.authCredential,
      {credentialKey: this.options.credentialKey},
    );
    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    // Without a scheme the handler has nothing to resolve and returns no
    // credential, so the configured one is used as it stands.
    const headers = await this.resolveHeaders(
      toolContext,
      authResult.authCredential ?? this.options.authCredential,
    );
    const progressCallback = this.resolveProgressCallback(toolContext);
    const session = await this.mcpSessionManager.createSession({headers});

    try {
      return await session.callTool(
        {name: this.originalName, arguments: request.args},
        undefined,
        {
          signal: toolContext.abortSignal,
          ...(progressCallback ? {onprogress: progressCallback} : {}),
        },
      );
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /** Merges the auth headers with the dynamic ones, which win a collision. */
  private async resolveHeaders(
    toolContext: Context,
    credential: AuthCredential | undefined,
  ): Promise<Record<string, string> | undefined> {
    const fromAuth = credentialHeaders(credential, this.options.authScheme);
    const fromProvider = await this.options.headerProvider?.(
      new ReadonlyContext(toolContext.invocationContext),
    );
    if (!fromAuth && !fromProvider) {
      // Undefined, not `{}`: the transport keeps its own configured headers.
      return undefined;
    }
    return {...fromAuth, ...fromProvider};
  }

  /** The progress callback for this invocation, direct or from the factory. */
  private resolveProgressCallback(
    toolContext: Context,
  ): McpProgressCallback | undefined {
    if (this.options.progressCallbackFactory) {
      return this.options.progressCallbackFactory(this.name, {
        callbackContext: toolContext,
      });
    }
    return this.options.progressCallback;
  }
}
