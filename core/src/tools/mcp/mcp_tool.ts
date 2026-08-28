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
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
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

/** Receives progress notifications from the server during a tool call. */
export type McpProgressCallback = (progress: Progress) => void;

/** Builds a progress callback per invocation, from the tool name and context. */
export type McpProgressCallbackFactory = (
  toolName: string,
  options: {callbackContext?: Context},
) => McpProgressCallback | undefined;

/** Supplies extra request headers per invocation. */
export type McpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/** Whether a call is gated on human approval: a flag, or a predicate. */
export type McpRequireConfirmation =
  | boolean
  | ((
      args: Record<string, unknown>,
      toolContext?: Context,
    ) => boolean | Promise<boolean>);

/** The optional behaviour an {@link MCPTool} can be built with. */
export interface McpToolOptions {
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;
  /** The credential to authenticate with, when the client does not supply one. */
  authCredential?: AuthCredential;
  /** The session-state key the resolved credential is stored under. */
  credentialKey?: string;
  /** Whether a call waits for human approval. */
  requireConfirmation?: McpRequireConfirmation;
  /** Extra headers, resolved per invocation and merged over the auth headers. */
  headerProvider?: McpHeaderProvider;
  /** A progress callback used for every invocation. */
  progressCallback?: McpProgressCallback;
  /** Builds a progress callback per invocation. */
  progressCallbackFactory?: McpProgressCallbackFactory;
}

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
    if (options.progressCallback && options.progressCallbackFactory) {
      throw new Error(
        'Supply either progressCallback or progressCallbackFactory, not both.',
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

  /**
   * Whether this call is gated on human approval — the static flag, or the
   * predicate evaluated against the arguments.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    const {requireConfirmation} = this.options;
    return typeof requireConfirmation === 'function'
      ? requireConfirmation(args, toolContext)
      : (requireConfirmation ?? false);
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const rejection = await this.checkConfirmation(request);
    if (rejection) {
      return rejection;
    }

    if (!isFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING)) {
      return this.callMcpTool(request);
    }

    try {
      return await this.callMcpTool(request);
    } catch (e: unknown) {
      return toErrorResult(e);
    }
  }

  /**
   * Evaluates the confirmation gate.
   *
   * @return Undefined when the call may proceed, otherwise the payload to
   *     return in its place: a request for approval on the first pass, or a
   *     rejection once the user declined.
   */
  private async checkConfirmation(
    request: RunAsyncToolRequest,
  ): Promise<McpToolErrorResult | undefined> {
    const {toolContext} = request;
    const required = await this.checkRequireConfirmation(
      request.args,
      toolContext,
    );
    if (!required) {
      return undefined;
    }
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint:
          `Please approve or reject the tool call ${this.name}() by ` +
          'responding with a FunctionResponse with an expected ' +
          'ToolConfirmation payload.',
      });
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    }
    if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }
    return undefined;
  }

  private async callMcpTool(
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

  /** Resolves the progress callback for this invocation, if there is one. */
  private resolveProgressCallback(
    toolContext: Context,
  ): McpProgressCallback | undefined {
    const {progressCallback, progressCallbackFactory} = this.options;
    return progressCallbackFactory
      ? progressCallbackFactory(this.name, {callbackContext: toolContext})
      : progressCallback;
  }
}
