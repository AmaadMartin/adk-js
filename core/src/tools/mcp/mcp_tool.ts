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

import {formatError, isConnectionError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {
  captureHttpDebug,
  HttpDebugRecord,
} from '../../utils/http_debug_utils.js';
import {logger, LogLevel} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {
  isMcpConnectionError,
  MCPSessionManager,
} from './mcp_session_manager.js';

/** Key under which a call's captured HTTP exchanges are published. */
const HTTP_DEBUG_INFO_KEY = 'http_debug_info';

/** Scheme every MCP App UI resource URI carries. */
const UI_RESOURCE_URI_SCHEME = 'ui://';

/** How many times one `runAsync` may issue the tool call. */
const MAX_CALL_ATTEMPTS = 2;

/** Narrows a value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the `ui` block out of a tool's `_meta`.
 *
 * A remote server controls `_meta`, so nothing about its shape is assumed.
 */
function uiMeta(tool: Tool): Record<string, unknown> | undefined {
  const ui = tool._meta?.['ui'];
  return isRecord(ui) ? ui : undefined;
}

/** Returns `uri` when it is a usable MCP App UI resource URI. */
function asResourceUri(uri: unknown): string | undefined {
  return typeof uri === 'string' && uri.startsWith(UI_RESOURCE_URI_SCHEME)
    ? uri
    : undefined;
}

/**
 * The active trace context, in the wire format the MCP `_meta` field carries.
 *
 * Returns `undefined` rather than an empty object when no context is active:
 * an empty `_meta` is a difference on the wire.
 */
function traceContextCarrier(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
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

  /** The MCP tool definition this tool wraps, as the server advertised it. */
  get rawMcpTool(): Tool {
    return this.mcpTool;
  }

  /**
   * The MCP App UI resource URI this tool declares, if any.
   *
   * MCP Apps advertise a UI resource in the tool's `_meta`, either nested as
   * `{ui: {resourceUri}}` or flat as `{'ui/resourceUri'}`. The flat spelling
   * is deprecated, so the nested one wins. Anything that does not name a
   * `ui://` resource is ignored.
   */
  get mcpAppResourceUri(): string | undefined {
    return (
      asResourceUri(uiMeta(this.mcpTool)?.['resourceUri']) ??
      asResourceUri(this.mcpTool._meta?.['ui/resourceUri'])
    );
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
    if (!(logger.isEnabledFor?.(LogLevel.DEBUG) ?? false)) {
      return this.callWithRetry(request);
    }
    const records: HttpDebugRecord[] = [];
    try {
      return await captureHttpDebug(records, () => this.callWithRetry(request));
    } finally {
      publishHttpDebugInfo(request, records);
    }
  }

  /**
   * Issues the call, retrying once against a fresh session when the first
   * attempt failed before the server answered.
   *
   * A protocol-level error is not retried: the server received the call, so a
   * replay could duplicate a remote side effect.
   */
  private async callWithRetry(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    let attempt = 1;
    for (;;) {
      try {
        return await this.callMcpTool(request);
      } catch (err) {
        const retryable = isConnectionError(err) || isMcpConnectionError(err);
        if (
          attempt >= MAX_CALL_ATTEMPTS ||
          !retryable ||
          request.toolContext.abortSignal?.aborted
        ) {
          throw err;
        }
        logger.debug(
          `Retrying MCP tool ${this.originalName} on a fresh session after: ` +
            formatError(err),
        );
        attempt++;
      }
    }
  }

  /** Opens a session, calls the tool on it, and closes it again. */
  private async callMcpTool(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult> {
    const session = await this.mcpSessionManager.createSession();
    try {
      // The MCP protocol carries the trace context in `_meta`. See
      // https://agentclientprotocol.com/protocol/extensibility#the-meta-field
      const meta = traceContextCarrier();
      const params: CallToolRequest['params'] = {
        name: this.originalName,
        arguments: request.args,
        ...(meta && {_meta: meta}),
      };
      const result = await session.callTool(params, undefined, {
        signal: request.toolContext.abortSignal,
      });
      this.pushUiWidget(request);
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Attaches an MCP App widget to the event actions, so the host UI can render
   * the app beside the agent's answer.
   */
  private pushUiWidget(request: RunAsyncToolRequest): void {
    const resourceUri = this.mcpAppResourceUri;
    if (!resourceUri) {
      return;
    }
    const {functionCallId} = request.toolContext;
    if (!functionCallId) {
      // A widget with no id cannot be addressed or de-duplicated, and losing
      // a rendering hint is better than failing the call over one.
      logger.debug(
        `Not rendering the MCP App widget for ${this.originalName}: the tool ` +
          'context carries no function call id to key it on.',
      );
      return;
    }
    request.toolContext.renderUiWidget({
      id: functionCallId,
      provider: 'mcp',
      payload: {
        resource_uri: resourceUri,
        tool: this.mcpTool,
        tool_args: request.args,
      },
    });
  }
}

/** Appends the captured exchanges to the invocation's metadata bag. */
function publishHttpDebugInfo(
  request: RunAsyncToolRequest,
  records: HttpDebugRecord[],
): void {
  if (records.length === 0) {
    return;
  }
  const metadata = request.toolContext.customMetadata;
  const existing = metadata[HTTP_DEBUG_INFO_KEY];
  metadata[HTTP_DEBUG_INFO_KEY] = Array.isArray(existing)
    ? [...existing, ...records]
    : records;
}
