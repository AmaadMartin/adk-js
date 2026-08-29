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

import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Whether the caller stopped the call, rather than the call failing on its
 * own. A cancelled call keeps throwing: the caller has stopped waiting, and
 * reporting it as a tool error would feed the model a failure it did not cause.
 */
function isCancellation(e: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true || (e instanceof Error && e.name === 'AbortError')
  );
}

/** Describes a failed tool call for the model, and logs the same message. */
function toErrorResult(e: unknown): {error: string} {
  // The MCP SDK's `McpError` is matched on `name` rather than with
  // `instanceof`: a runtime import of `@modelcontextprotocol/sdk` would make
  // the optional peer mandatory for the `@google/adk` barrel, and `instanceof`
  // fails across two copies of the SDK in one runtime.
  const summary =
    e instanceof Error && e.name === 'McpError'
      ? 'MCP tool execution failed'
      : 'Unexpected error during MCP tool execution';
  const error = `${summary}: ${formatError(e)}`;
  logger.warn(error);
  return {error};
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
 * A failed call is reported to the model as an `{error}` result, so a server
 * that rejects one call does not end the agent turn. Disable the
 * {@link FeatureName.MCP_GRACEFUL_ERROR_HANDLING} feature to make the failure
 * throw instead. A cancelled call always throws.
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
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
    try {
      return await this.callMcpTool(request);
    } catch (e: unknown) {
      if (
        !isFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING) ||
        isCancellation(e, request.toolContext.abortSignal)
      ) {
        throw e;
      }
      return toErrorResult(e);
    }
  }

  /** Opens a session, calls the remote tool, and closes the session. */
  private async callMcpTool(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    const session = await this.mcpSessionManager.createSession();

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
