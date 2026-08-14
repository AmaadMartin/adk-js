/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {ProgressCallback} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequest,
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {Context} from '../../agents/context.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/** Arguments handed to an {@link MCPProgressCallbackFactory}. */
export interface MCPProgressCallbackFactoryRequest {
  /** The ADK-visible tool name, including the toolset prefix when one is set. */
  toolName: string;
  /** The context of the current invocation; may read and write session state. */
  callbackContext: Context;
}

/**
 * Builds a progress callback for a single tool invocation, or returns
 * `undefined` to receive no progress notifications for that invocation.
 */
export type MCPProgressCallbackFactory = (
  request: MCPProgressCallbackFactoryRequest,
) => ProgressCallback | undefined;

/**
 * Progress-notification options for {@link MCPTool} and {@link MCPToolset}.
 *
 * Supply at most one of the two fields. An MCP server reports progress for a
 * long-running tool through `notifications/progress`; ADK only asks for those
 * notifications when a callback is configured.
 */
export interface MCPProgressOptions {
  /** A single callback used for every invocation. */
  progressCallback?: ProgressCallback;
  /** Builds a callback per invocation. Mutually exclusive with `progressCallback`. */
  progressCallbackFactory?: MCPProgressCallbackFactory;
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
  private readonly progressCallback?: ProgressCallback;
  private readonly progressCallbackFactory?: MCPProgressCallbackFactory;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    options: MCPProgressOptions = {},
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    if (options.progressCallback && options.progressCallbackFactory) {
      throw new Error(
        'MCPTool accepts either progressCallback or progressCallbackFactory, not both.',
      );
    }
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.progressCallback = options.progressCallback;
    this.progressCallbackFactory = options.progressCallbackFactory;
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
      const onprogress =
        this.progressCallbackFactory?.({
          toolName: this.name,
          callbackContext: request.toolContext,
        }) ?? this.progressCallback;
      const result = await session.callTool(callRequest.params, undefined, {
        signal: request.toolContext.abortSignal,
        ...(onprogress ? {onprogress} : {}),
      });
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }
}
