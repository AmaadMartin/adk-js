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
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {isRecord, isStringArray} from '../../utils/type_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/** The `error.type` reported for a call the MCP server marked as failed. */
const MCP_TOOL_ERROR = 'MCP_TOOL_ERROR';

/** The `ui` block a tool declares in its `_meta`, when it declares one. */
function uiMeta(tool: Tool): Record<string, unknown> | undefined {
  const ui = isRecord(tool._meta) ? tool._meta['ui'] : undefined;
  return isRecord(ui) ? ui : undefined;
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

  /**
   * The audiences the MCP server declares this tool's user interface for, or
   * an empty list when it declares none.
   *
   * The list arrives from a remote server, so a `visibility` that is not a
   * list of strings is reported as no declaration. adk-python returns the raw
   * value; a caller of a `string[]` getter cannot survive that.
   */
  get visibility(): string[] {
    const visibility = uiMeta(this.mcpTool)?.['visibility'];
    return isStringArray(visibility) ? visibility : [];
  }

  /**
   * Reports a result the MCP server marked with `isError` as a failed call.
   *
   * A server reports a tool failure inside the result rather than by failing
   * the request, so without this the span records the call as a success.
   */
  override detectErrorInResponse(response: unknown): string | undefined {
    return isRecord(response) && response['isError']
      ? MCP_TOOL_ERROR
      : undefined;
  }

  override _getDeclaration(): FunctionDeclaration {
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.mcpTool.name,
        description: this.mcpTool.description,
        parametersJsonSchema: this.mcpTool.inputSchema,
        responseJsonSchema: this.mcpTool.outputSchema,
      };
    }
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
