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
import {context, propagation} from '@opentelemetry/api';

import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {isLogLevelEnabled, LogLevel} from '../../utils/logger.js';
import {isRecord} from '../../utils/type_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {mcpHttpDebugStorage, McpHttpExchange} from './http_debug_recorder.js';
import {MCPSessionManager} from './mcp_session_manager.js';

/** The scheme every MCP App UI resource URI carries. */
const UI_RESOURCE_URI_PREFIX = 'ui://';

/**
 * The deprecated flat spelling of the resource URI, from the MCP Apps
 * extension specification. Servers still emit it, so it is read as a fallback.
 */
const FLAT_RESOURCE_URI_KEY = 'ui/resourceUri';

/** The widget provider a UI host selects to render an MCP App iframe. */
const MCP_WIDGET_PROVIDER = 'mcp';

/** Where a drained HTTP debug recording lands on the invocation. */
const HTTP_DEBUG_INFO_KEY = 'http_debug_info';

/** Whether the value is an MCP App UI resource URI. */
function isUiResourceUri(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(UI_RESOURCE_URI_PREFIX);
}

/**
 * Reads the MCP App UI resource URI a server declared on `tool`.
 *
 * The nested spelling wins over the deprecated flat one. `_meta` comes from a
 * remote server, so every level is narrowed rather than asserted; anything
 * that is not a `ui://` string reads as no declaration at all.
 */
function readMcpAppResourceUri(tool: Tool): string | undefined {
  const meta = tool._meta;
  if (!isRecord(meta)) {
    return undefined;
  }

  const ui = meta['ui'];
  if (isRecord(ui)) {
    const nested = ui['resourceUri'];
    if (isUiResourceUri(nested)) {
      return nested;
    }
  }

  const flat = meta[FLAT_RESOURCE_URI_KEY];
  return isUiResourceUri(flat) ? flat : undefined;
}

/**
 * The active trace context as MCP request metadata, or nothing when no
 * propagator produced any.
 *
 * The MCP protocol reserves `_meta` on a request for this kind of extension,
 * so a server can join the caller's trace. Returning `undefined` for an empty
 * carrier keeps the bytes on the wire identical to today's for a run with no
 * telemetry configured.
 */
function injectTraceContext(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

/** Moves the recorded exchanges onto the invocation's metadata. */
function drainHttpExchanges(
  sink: McpHttpExchange[],
  customMetadata: Record<string, unknown>,
): void {
  if (sink.length === 0) {
    return;
  }

  const recorded = customMetadata[HTTP_DEBUG_INFO_KEY];
  if (Array.isArray(recorded)) {
    recorded.push(...sink);
  } else {
    customMetadata[HTTP_DEBUG_INFO_KEY] = [...sink];
  }
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

  /** The MCP tool definition this tool wraps, as the server declared it. */
  get rawMcpTool(): Tool {
    return this.mcpTool;
  }

  /**
   * The MCP App UI resource URI this tool declares, when it declares one.
   *
   * A tool backed by an MCP App names a `ui://` resource that a UI host
   * renders alongside the tool response.
   */
  get mcpAppResourceUri(): string | undefined {
    return readMcpAppResourceUri(this.mcpTool);
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
    if (!isLogLevelEnabled(LogLevel.DEBUG)) {
      return this.callRemoteTool(request);
    }

    const sink: McpHttpExchange[] = [];
    try {
      return await mcpHttpDebugStorage.run(sink, () =>
        this.callRemoteTool(request),
      );
    } finally {
      drainHttpExchanges(sink, request.toolContext.customMetadata);
    }
  }

  /** Opens a session, calls the remote tool once, and closes the session. */
  private async callRemoteTool(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    const session = await this.mcpSessionManager.createSession();

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: request.args};
      const traceContext = injectTraceContext();
      if (traceContext) {
        callRequest.params._meta = traceContext;
      }
      const result = await session.callTool(callRequest.params, undefined, {
        signal: request.toolContext.abortSignal,
      });
      this.renderMcpAppWidget(request);
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Pushes this tool's MCP App widget onto the event actions, when the tool
   * declares one and the call carries an id a UI host can address it by.
   */
  private renderMcpAppWidget(request: RunAsyncToolRequest): void {
    const resourceUri = this.mcpAppResourceUri;
    const {functionCallId} = request.toolContext;
    if (!resourceUri || !functionCallId) {
      return;
    }

    request.toolContext.renderUiWidget({
      id: functionCallId,
      provider: MCP_WIDGET_PROVIDER,
      // snake_case: the payload crosses the wire verbatim to a UI host.
      payload: {
        resource_uri: resourceUri,
        tool: this.mcpTool,
        tool_args: request.args,
      },
    });
  }
}
