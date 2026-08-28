/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionDeclaration} from '@google/genai';
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
import type {RunAsyncToolRequest} from '../base_tool.js';
import {BaseTool} from '../base_tool.js';

import type {MCPSessionManager} from './mcp_session_manager.js';

/** Scheme that every MCP-App UI resource URI carries. */
const UI_RESOURCE_URI_SCHEME = 'ui://';

/** Deprecated flat spelling of the MCP-App UI resource URI key. */
const FLAT_UI_RESOURCE_URI_KEY = 'ui/resourceUri';

/** What the error boundary hands to the model in place of a thrown error. */
interface McpToolErrorResult {
  error: string;
}

/** Narrows a value read out of an untyped `_meta` block to a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the value when it is a UI resource URI, and undefined otherwise. */
function asUiResourceUri(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith(UI_RESOURCE_URI_SCHEME)
    ? value
    : undefined;
}

/**
 * Type guard for the MCP SDK's `McpError`.
 *
 * Matches on `name` rather than with `instanceof`, which would need a runtime
 * import of `@modelcontextprotocol/sdk`. The SDK is an optional peer, so such
 * an import would break the `@google/adk` barrel for everyone who never
 * installed it.
 */
function isMcpError(e: unknown): e is Error {
  return e instanceof Error && e.name === 'McpError';
}

/** Describes a failed tool call for the model, and logs the same message. */
function toErrorResult(e: unknown): McpToolErrorResult {
  const error = isMcpError(e)
    ? `MCP tool execution failed: ${e.message}`
    : `Unexpected error during MCP tool execution: ${formatError(e)}`;
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
 * A failed call throws by default. Enable the
 * {@link FeatureName.MCP_GRACEFUL_ERROR_HANDLING} feature to receive an
 * `{error}` result instead, which lets the agent turn continue.
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

  /** The tool declaration exactly as the MCP server advertised it. */
  get rawMcpTool(): Tool {
    return this.mcpTool;
  }

  /**
   * The surfaces this tool is visible on, from `_meta.ui.visibility`.
   *
   * Empty when the server declares no visibility. Non-string entries are
   * dropped.
   */
  get visibility(): string[] {
    const declared = asRecord(this.mcpTool._meta?.['ui'])?.['visibility'];
    if (!Array.isArray(declared)) {
      return [];
    }
    return declared.filter(
      (entry): entry is string => typeof entry === 'string',
    );
  }

  /**
   * The MCP-App UI resource URI this tool declares, or undefined for a tool
   * that declares none.
   *
   * Reads the nested `_meta.ui.resourceUri` form first, then the deprecated
   * flat `_meta['ui/resourceUri']` form. See
   * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
   */
  get mcpAppResourceUri(): string | undefined {
    const meta = this.mcpTool._meta;
    return (
      asUiResourceUri(asRecord(meta?.['ui'])?.['resourceUri']) ??
      asUiResourceUri(meta?.[FLAT_UI_RESOURCE_URI_KEY])
    );
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (!isFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING)) {
      return this.callMcpTool(request);
    }

    try {
      return await this.callMcpTool(request);
    } catch (e: unknown) {
      return toErrorResult(e);
    }
  }

  private async callMcpTool(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    const session = await this.mcpSessionManager.createSession();

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: request.args};
      const result = await this.mcpSessionManager.withTimeout(
        'callTool',
        (options) =>
          session.callTool(callRequest.params, undefined, {
            ...options,
            signal: request.toolContext.abortSignal,
          }),
      );
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }
}
