/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolRequest,
  CallToolResult,
  Progress,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {Context} from '../../agents/context.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {
  checkToolConfirmation,
  RequireConfirmationPredicate,
} from '../tool_confirmation.js';

import {MCPHeaderProvider, MCPSessionManager} from './mcp_session_manager.js';

/** Receives a progress notification the MCP server sends during a call. */
export type ProgressFn = (progress: Progress) => void | Promise<void>;

/** Configures an {@link MCPTool}. */
export interface MCPToolOptions {
  /** The tool descriptor the MCP server advertised. */
  mcpTool: Tool;
  /** Opens the sessions this tool calls over. */
  mcpSessionManager: MCPSessionManager;
  /** The server-side name, when the toolset prefixed the advertised one. */
  originalName?: string;
  /** Whether a human must approve a call before it reaches the server. */
  requireConfirmation?: boolean | RequireConfirmationPredicate;
  /** Receives progress notifications for every call. */
  progressCallback?: ProgressFn;
  /** Resolves extra request headers before each call opens its session. */
  headerProvider?: MCPHeaderProvider;
}

/**
 * Reads the options out of either constructor form.
 *
 * The forms are told apart by `mcpTool`: {@link MCPToolOptions} always carries
 * it and an MCP `Tool` never does.
 *
 * @throws If the positional form names no session manager. TypeScript already
 *     rejects that call, so the guard is for an untyped JavaScript caller.
 */
function normalizeToolOptions(
  optionsOrMcpTool: MCPToolOptions | Tool,
  mcpSessionManager?: MCPSessionManager,
  originalName?: string,
): MCPToolOptions {
  if ('mcpTool' in optionsOrMcpTool) {
    return optionsOrMcpTool;
  }
  if (!mcpSessionManager) {
    throw new Error('Missing session manager in MCPTool.');
  }
  return {mcpTool: optionsOrMcpTool, mcpSessionManager, originalName};
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
  private readonly requireConfirmation: boolean | RequireConfirmationPredicate;
  private readonly progressCallback?: ProgressFn;
  private readonly headerProvider?: MCPHeaderProvider;

  constructor(options: MCPToolOptions);
  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
  );
  constructor(
    optionsOrMcpTool: MCPToolOptions | Tool,
    mcpSessionManager?: MCPSessionManager,
    originalName?: string,
  ) {
    const options = normalizeToolOptions(
      optionsOrMcpTool,
      mcpSessionManager,
      originalName,
    );
    super({
      name: options.mcpTool.name,
      description: options.mcpTool.description || '',
    });
    this.mcpTool = options.mcpTool;
    this.mcpSessionManager = options.mcpSessionManager;
    this.originalName = options.originalName || options.mcpTool.name;
    this.requireConfirmation = options.requireConfirmation ?? false;
    this.progressCallback = options.progressCallback;
    this.headerProvider = options.headerProvider;
  }

  /**
   * Whether this call needs a human to approve it.
   *
   * The resume path asks the same question a turn later, so without this
   * override it refuses a valid approval with `confirmation_not_required`.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    return typeof this.requireConfirmation === 'function'
      ? this.requireConfirmation(args, toolContext)
      : this.requireConfirmation;
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
    const gate = await checkToolConfirmation({
      toolName: this.name,
      requireConfirmation: await this.checkRequireConfirmation(
        request.args,
        request.toolContext,
      ),
      toolContext: request.toolContext,
    });
    // A gated call must not reach the MCP server.
    if (gate) {
      return gate;
    }

    // Headers are resolved per call, not per discovery, so a short-lived
    // credential is still valid when the call runs.
    const headers = await this.headerProvider?.(request.toolContext);
    const session = await this.mcpSessionManager.createSession(headers);

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: request.args};
      const result = await session.callTool(
        callRequest.params,
        undefined,
        this.buildRequestOptions(request),
      );
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Builds the per-call SDK request options.
   *
   * `onprogress` is left off entirely when no callback is configured: the SDK
   * only sends a progress token, and so the server only reports progress, when
   * the key is present.
   */
  private buildRequestOptions(request: RunAsyncToolRequest): RequestOptions {
    const onprogress = this.progressCallback;

    return {
      signal: request.toolContext.abortSignal,
      ...(onprogress ? {onprogress} : {}),
    };
  }
}
