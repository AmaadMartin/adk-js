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

import {Context} from '../../agents/context.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {isDebugEnabled} from '../../utils/logger.js';
import {retryOnce} from '../../utils/retry_utils.js';
import {isRecord} from '../../utils/type_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {
  HttpDebugExchange,
  runWithHttpDebugSink,
} from './http_debug_recorder.js';
import {MCPSessionManager} from './mcp_session_manager.js';

/** The scheme an MCP App UI resource is served under. */
const UI_RESOURCE_SCHEME = 'ui://';

/** Widget provider identifier for an MCP App iframe. */
const MCP_WIDGET_PROVIDER = 'mcp';

/** Where a run's recorded HTTP exchanges land on the invocation. */
const HTTP_DEBUG_METADATA_KEY = 'http_debug_info';

/** Returns `value` when it is an MCP App UI resource URI. */
function asUiResourceUri(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith(UI_RESOURCE_SCHEME)
    ? value
    : undefined;
}

/**
 * Appends `exchanges` to the invocation's `http_debug_info`, leaving the key
 * absent when nothing was recorded.
 */
function appendHttpDebugInfo(
  toolContext: Context,
  exchanges: HttpDebugExchange[],
): void {
  if (exchanges.length === 0) {
    return;
  }
  const metadata = toolContext.customMetadata;
  const recorded = metadata[HTTP_DEBUG_METADATA_KEY];
  metadata[HTTP_DEBUG_METADATA_KEY] = Array.isArray(recorded)
    ? [...recorded, ...exchanges]
    : exchanges;
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
   * The MCP tool declaration this tool wraps, as the server sent it.
   *
   * A server may declare fields ADK does not model. Read them here rather than
   * off the ADK wrapper, which exposes only what it understands.
   */
  get rawMcpTool(): Tool {
    return this.mcpTool;
  }

  /**
   * The MCP App UI resource URI this tool declares, or `undefined`.
   *
   * An MCP App declares its UI resource in the tool's `_meta`, either nested
   * as `{ui: {resourceUri: 'ui://...'}}` or flat as
   * `{'ui/resourceUri': 'ui://...'}`. The flat form is specified by the MCP
   * apps extension:
   * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
   *
   * `_meta` arrives from a remote server, so anything that is not a `ui://`
   * string reads as "no MCP App declared" rather than raising.
   */
  get mcpAppResourceUri(): string | undefined {
    const meta = this.rawMcpTool._meta;
    if (!isRecord(meta)) {
      return undefined;
    }

    const ui = meta['ui'];
    if (isRecord(ui)) {
      const nested = asUiResourceUri(ui['resourceUri']);
      if (nested) {
        return nested;
      }
    }

    return asUiResourceUri(meta['ui/resourceUri']);
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
    if (!isDebugEnabled()) {
      return this.callRemoteTool(request);
    }

    const exchanges: HttpDebugExchange[] = [];
    try {
      return await runWithHttpDebugSink(exchanges, () =>
        this.callRemoteTool(request),
      );
    } finally {
      // In a `finally` so a failed call still reports what it sent, which is
      // the exchange an operator is usually after.
      appendHttpDebugInfo(request.toolContext, exchanges);
    }
  }

  /**
   * Opens a session, calls the tool once, and closes the session.
   *
   * Session setup is retried once because it happens before the call exists,
   * so a failure there provably ran nothing on the server. The call itself is
   * never retried: replaying it after an ambiguous transport failure could
   * duplicate a remote side effect.
   */
  private async callRemoteTool(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    const {args, toolContext} = request;

    const session = await retryOnce(
      () => this.mcpSessionManager.createSession(),
      'MCP session setup',
      toolContext.abortSignal,
    );

    try {
      const result = await session.callTool(
        this.buildCallParams(args),
        undefined,
        {signal: toolContext.abortSignal},
      );
      this.pushUiWidget(toolContext, args);
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Builds the `tools/call` params, carrying the active trace context in
   * `_meta` so the server's spans join this trace. See
   * https://agentclientprotocol.com/protocol/extensibility#the-meta-field
   *
   * With no propagator registered and no active span the carrier is empty, and
   * the key is left off entirely.
   */
  private buildCallParams(
    args: Record<string, unknown>,
  ): CallToolRequest['params'] {
    const params: CallToolRequest['params'] = {
      name: this.originalName,
      arguments: args,
    };

    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
    if (Object.keys(traceCarrier).length > 0) {
      params._meta = traceCarrier;
    }

    return params;
  }

  /**
   * Hands a UI host what it needs to render this tool's MCP App next to the
   * function response. The widget is keyed by the function call id, so a call
   * without one renders nothing.
   */
  private pushUiWidget(
    toolContext: Context,
    args: Record<string, unknown>,
  ): void {
    const resourceUri = this.mcpAppResourceUri;
    if (!resourceUri || !toolContext.functionCallId) {
      return;
    }

    toolContext.renderUiWidget({
      id: toolContext.functionCallId,
      provider: MCP_WIDGET_PROVIDER,
      payload: {
        resource_uri: resourceUri,
        tool: this.rawMcpTool,
        tool_args: args,
      },
    });
  }
}
