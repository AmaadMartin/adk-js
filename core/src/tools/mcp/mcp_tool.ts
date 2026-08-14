/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {
  CallToolRequest,
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type {Context} from '../../agents/context.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {checkToolConfirmation} from '../tool_confirmation.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Whether an {@link MCPTool} call requires user confirmation before it is sent
 * to the MCP server: a boolean, or a predicate over the call arguments and the
 * tool context.
 *
 * The gate is enforced when the tool is invoked through an `LlmAgent` turn:
 * `agents/functions.ts` surfaces an `adk_request_confirmation` interrupt from
 * the tool's `requestedToolConfirmations`, and the call only reaches the MCP
 * server once the user approves (via the
 * `RequestConfirmationLlmRequestProcessor`).
 *
 * NOTE: a workflow `ToolNode` does not yet route through that path, so a gated
 * tool used directly as a node does not pause — it returns the "requires
 * confirmation" error as its node output. This limitation is shared with
 * `FunctionTool`.
 */
export type MCPRequireConfirmation =
  | boolean
  | ((
      args: Record<string, unknown>,
      toolContext: Context,
    ) => boolean | Promise<boolean>);

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
 * An MCP server is third-party code and can advertise destructive tools, so
 * `requireConfirmation` holds the call for user approval before it reaches the
 * server. Mirrors Python's `McpTool(require_confirmation=...)`.
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;
  private readonly requireConfirmation: MCPRequireConfirmation;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    requireConfirmation: MCPRequireConfirmation = false,
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.requireConfirmation = requireConfirmation;
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
    // The gate runs before createSession(): opening a session is itself a side
    // effect, since a stdio transport spawns the server process.
    const requireConfirmation =
      typeof this.requireConfirmation === 'function'
        ? await this.requireConfirmation(request.args, request.toolContext)
        : this.requireConfirmation;
    if (requireConfirmation) {
      const pending = checkToolConfirmation(this.name, request.toolContext);
      if (pending !== undefined) {
        return pending;
      }
    }

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
