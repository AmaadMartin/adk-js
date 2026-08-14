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

import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {RESERVED_TOOL_NAMES} from '../reserved_tool_names.js';

import {MCPSessionManager} from './mcp_session_manager.js';

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

  /**
   * @param mcpTool The tool definition, whose `name` is the exposed name the
   *   model will call (already prefixed by the toolset, if it applies one).
   * @param mcpSessionManager The session manager used to reach the server.
   * @param originalName The native name on the server, when it differs from
   *   the exposed name. Defaults to `mcpTool.name`.
   * @throws If the exposed name is one of the reserved ADK tool names, since
   *   such a tool would shadow a framework function call.
   */
  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
  ) {
    if (RESERVED_TOOL_NAMES.has(mcpTool.name)) {
      throw new Error(
        `MCP tool name '${mcpTool.name}' collides with a reserved ADK tool name.`,
      );
    }
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
