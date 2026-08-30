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
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/** The `error.type` recorded when an MCP server reports a failed call. */
const MCP_TOOL_ERROR = 'MCP_TOOL_ERROR';

/** The `_meta` key MCP Apps declare their user interface under. */
const UI_META_KEY = 'ui';

/**
 * The visibility list an MCP server declares under `_meta.ui.visibility`.
 *
 * `_meta` is an open extension point, so a server can put anything in it.
 * Anything other than a list of strings reads as no declaration at all, which
 * keeps a malformed block from reaching a caller as a wrongly-typed value.
 */
function readUiVisibility(meta: Tool['_meta']): string[] {
  const ui = meta?.[UI_META_KEY];
  if (typeof ui !== 'object' || ui === null) {
    return [];
  }
  const declared: unknown = (ui as Record<string, unknown>)['visibility'];
  if (!Array.isArray(declared)) {
    return [];
  }
  const entries: unknown[] = declared;
  return entries.every((entry) => typeof entry === 'string') ? entries : [];
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
   * The visibility an MCP App declares for this tool, or `[]` when it declares
   * none. Mirrors adk-python's `MCPTool.visibility`.
   */
  get visibility(): string[] {
    return readUiVisibility(this.mcpTool._meta);
  }

  /**
   * Renders this tool as the declaration sent to the model.
   *
   * Exactly one of `parameters` and `parametersJsonSchema` is populated. The
   * {@link FeatureName.JSON_SCHEMA_FOR_FUNC_DECL} feature selects the
   * JSON-schema form, which sends the server's own schemas verbatim. The
   * genai `Schema` form is the default, and it drops the JSON Schema keywords
   * `toGeminiSchema` cannot express, such as `oneOf` and `$ref`.
   */
  override _getDeclaration(): FunctionDeclaration {
    const {name, description, inputSchema, outputSchema} = this.mcpTool;
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name,
        description,
        parametersJsonSchema: inputSchema,
        responseJsonSchema: outputSchema,
      };
    }
    return {
      name,
      description,
      parameters: toGeminiSchema(inputSchema),
      // TODO: need revisit, refer to this
      // https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result
      response: toGeminiSchema(outputSchema),
    };
  }

  /**
   * The error type to record on this call's telemetry span, or `undefined`
   * when the server did not report a failure.
   *
   * An MCP server reports a failed call with `isError` on the result instead
   * of raising, so a trace cannot otherwise tell the failure from a success.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    return typeof response === 'object' &&
      response !== null &&
      'isError' in response &&
      response.isError
      ? MCP_TOOL_ERROR
      : undefined;
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
