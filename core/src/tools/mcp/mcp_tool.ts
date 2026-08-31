/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {ProgressCallback} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolRequest,
  CallToolResult,
  Progress,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {Context} from '../../agents/context.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyConfirmationGate} from '../tool_confirmation.js';

import {
  createMcpAuthConfig,
  McpAuthOptions,
  resolveMcpHeaders,
} from './mcp_auth.js';
import {MCPSessionManager} from './mcp_session_manager.js';

/** Receives a progress notification sent while an MCP tool call runs. */
export type McpProgressCallback = (progress: Progress) => void | Promise<void>;

/**
 * Creates the progress callback for one tool, so different tools can report
 * progress differently and reach the invocation they belong to.
 *
 * @param toolName The name of the MCP tool about to run.
 * @param options.callbackContext The context of the call.
 * @return The callback for this call, or `undefined` to report no progress.
 */
export type McpProgressCallbackFactory = (
  toolName: string,
  options: {callbackContext: Context},
) => McpProgressCallback | undefined;

/** Decides, per call, whether an MCP tool call needs human approval. */
export type RequireMcpConfirmation = (
  args: Record<string, unknown>,
  toolContext?: Context,
) => boolean | Promise<boolean>;

/** The optional behaviour an MCP toolset configures on each {@link MCPTool}. */
export interface McpToolOptions extends McpAuthOptions {
  /**
   * Whether this call needs human approval before it runs: a flag, or a
   * predicate over the call arguments and the tool context.
   */
  requireConfirmation?: boolean | RequireMcpConfirmation;

  /** A progress callback shared by every call of this tool. */
  progressCallback?: McpProgressCallback;

  /**
   * Builds a progress callback per call. Takes precedence over
   * {@link McpToolOptions.progressCallback} when both are set.
   */
  progressCallbackFactory?: McpProgressCallbackFactory;

  /**
   * The auth config to read the exchanged credential from, instead of building
   * one from the fields above.
   *
   * A toolset passes its own instance to every tool it creates, so the
   * credential the host exchanges on that one config reaches all of them.
   */
  authConfig?: AuthConfig;
}

/**
 * Adapts an ADK progress callback to the one the MCP SDK calls.
 *
 * The SDK's callback returns `void`, so a rejected handler would surface as an
 * unhandled rejection. A progress notification is not worth failing a tool call
 * over, so a failure is logged and swallowed.
 */
function toProgressCallback(callback: McpProgressCallback): ProgressCallback {
  return (progress) => {
    void Promise.resolve()
      .then(() => callback(progress))
      .catch((err: unknown) => {
        logger.warn('MCP progress callback failed: ' + formatError(err));
      });
  };
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
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;
  private readonly options: McpToolOptions;
  private readonly authConfig?: AuthConfig;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    options: McpToolOptions = {},
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.options = options;
    this.authConfig = options.authConfig ?? createMcpAuthConfig(options);
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

  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    const requireConfirmation = this.options.requireConfirmation ?? false;
    return typeof requireConfirmation === 'function'
      ? requireConfirmation(args, toolContext)
      : requireConfirmation;
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (
      await this.checkRequireConfirmation(request.args, request.toolContext)
    ) {
      const gate = applyConfirmationGate(this.name, request.toolContext);
      if (gate) {
        return gate;
      }
    }

    const headers = await resolveMcpHeaders(
      this.authConfig,
      this.options.headerProvider,
      request.toolContext,
    );
    const session = await this.mcpSessionManager.createSession(headers);

    try {
      const params: CallToolRequest['params'] = {
        name: this.originalName,
        arguments: request.args,
      };
      const result = await session.callTool(params, undefined, {
        signal: request.toolContext.abortSignal,
        onprogress: this.resolveProgressCallback(request.toolContext),
      });
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /** The progress handler for this call, when one is configured. */
  private resolveProgressCallback(
    toolContext: Context,
  ): ProgressCallback | undefined {
    const {progressCallback, progressCallbackFactory} = this.options;
    const callback = progressCallbackFactory
      ? progressCallbackFactory(this.name, {callbackContext: toolContext})
      : progressCallback;
    return callback ? toProgressCallback(callback) : undefined;
  }
}
