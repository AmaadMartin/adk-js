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
import {context as otelContext, propagation} from '@opentelemetry/api';

import {Context} from '../../agents/context.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_TOOL_NAME,
} from '../../agents/framework_function_calls.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';

import {credentialToHeaders} from './auth_headers.js';
import {MCPSessionManager} from './mcp_session_manager.js';

/** Scheme that every MCP-App UI resource URI carries. */
const UI_RESOURCE_URI_SCHEME = 'ui://';

/** Deprecated flat spelling of the MCP-App UI resource URI key. */
const FLAT_UI_RESOURCE_URI_KEY = 'ui/resourceUri';

/**
 * Names the framework itself puts on the wire; an MCP server may not claim one.
 *
 * A server tool answering to one of these would be dispatched in place of the
 * framework's own call, so the name is refused when the tool is built. Only an
 * exact match is refused: `transfer_to_agent_v2` is a legal MCP tool name.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_TOOL_NAME,
]);

/** What `runAsync` returns when the client still has to supply a credential. */
const PENDING_AUTHORIZATION = 'Pending User Authorization.';

/**
 * Receives progress notifications from the server during a tool call.
 *
 * The second argument names the tool and carries the context of the invocation
 * reporting progress, so one callback can serve every tool of a toolset and
 * still tell the calls apart.
 */
export type McpProgressCallback = (
  progress: Progress,
  invocation: {toolName: string; callbackContext: Context},
) => void;

/** Supplies extra request headers per invocation. */
export type McpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * The optional behaviour an {@link MCPTool} can be built with.
 *
 * `MCPToolset` takes the same object and forwards it to every tool it builds,
 * because the toolset is the normal entry point: a tool nobody constructs by
 * hand still has to be able to authenticate.
 */
export interface McpToolOptions {
  /**
   * The scheme the MCP server authenticates with.
   *
   * An API key needs an `apiKey` scheme to name the header it goes in, and
   * that scheme must read `in: 'header'`: MCP has no query string and no
   * cookie jar to carry a key in, so any other location is refused.
   */
  authScheme?: AuthScheme;
  /**
   * The credential to authenticate with, when the client supplies none.
   *
   * It is resolved through `ToolAuthHandler` and turned into request headers.
   * OAuth2 and HTTP bearer become `Authorization: Bearer <token>`, HTTP basic
   * becomes a base64 pair, any other HTTP scheme becomes `<scheme> <token>`,
   * and an API key goes in the header its scheme names. A service account must
   * be exchanged for an access token first, and contributes no headers.
   *
   * When the client still has to supply the credential, the call returns
   * `'Pending User Authorization.'` and opens no session.
   */
  authCredential?: AuthCredential;
  /** The session-state key the resolved credential is stored under. */
  credentialKey?: string;
  /**
   * Extra headers, resolved per invocation and merged over the auth headers,
   * so the provider wins a key collision. Use it for what changes per turn: a
   * tenant, a request id, a short-lived token.
   */
  headerProvider?: McpHeaderProvider;
  /** Reports the progress the server sends during a call. */
  progressCallback?: McpProgressCallback;
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
 * The active trace context, as an MCP `_meta` block.
 *
 * The MCP protocol carries out-of-band data in `_meta`, which is where a trace
 * belongs. Returns undefined when no propagator is registered, so a request
 * from an untraced application keeps the parameters it always had.
 */
function injectedTraceContext(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
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
  private readonly options: McpToolOptions;

  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
    options: McpToolOptions = {},
  ) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    if (RESERVED_TOOL_NAMES.has(mcpTool.name)) {
      throw new Error(
        `MCP tool name '${mcpTool.name}' collides with a reserved ADK tool name.`,
      );
    }
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
    this.originalName = originalName || mcpTool.name;
    this.options = options;
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

  override async runAsync(
    request: RunAsyncToolRequest,
  ): Promise<CallToolResult | string> {
    const {toolContext} = request;
    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      this.options.authScheme,
      this.options.authCredential,
      {credentialKey: this.options.credentialKey},
    );
    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return PENDING_AUTHORIZATION;
    }

    const headers = await this.resolveHeaders(
      authResult.authCredential,
      toolContext,
    );
    const session = await this.mcpSessionManager.createSession({headers});

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: request.args};
      const traceContext = injectedTraceContext();
      if (traceContext) {
        callRequest.params._meta = traceContext;
      }

      const options: RequestOptions = {signal: toolContext.abortSignal};
      const onprogress = this.resolveProgressCallback(toolContext);
      if (onprogress) {
        options.onprogress = onprogress;
      }

      const result = await session.callTool(
        callRequest.params,
        undefined,
        options,
      );
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Merges the credential's headers with the provider's, for one invocation.
   *
   * The provider wins a key collision, and a merge that produced nothing is
   * reported as no headers rather than as an empty map.
   */
  private async resolveHeaders(
    credential: AuthCredential | undefined,
    toolContext: Context,
  ): Promise<Record<string, string> | undefined> {
    const authHeaders = credentialToHeaders(
      credential,
      this.options.authScheme,
    );
    const providedHeaders = await this.options.headerProvider?.(toolContext);
    const headers = {...authHeaders, ...providedHeaders};
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /** Binds the progress callback to this invocation, if there is one. */
  private resolveProgressCallback(
    toolContext: Context,
  ): ((progress: Progress) => void) | undefined {
    const {progressCallback} = this.options;
    if (!progressCallback) {
      return undefined;
    }
    return (progress) =>
      progressCallback(progress, {
        toolName: this.name,
        callbackContext: toolContext,
      });
  }
}
