/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CallToolRequest,
  CallToolResult,
  Progress,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {Context} from '../../agents/context.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
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

import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Whether the caller stopped the call, rather than the call failing on its
 * own. A cancelled call keeps throwing: the caller has stopped waiting, and
 * reporting it as a tool error would feed the model a failure it did not cause.
 */
function isCancellation(e: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true || (e instanceof Error && e.name === 'AbortError')
  );
}

/** Describes a failed tool call for the model, and logs the same message. */
function toErrorResult(e: unknown): {error: string} {
  // The MCP SDK's `McpError` is matched on `name` rather than with
  // `instanceof`: a runtime import of `@modelcontextprotocol/sdk` would make
  // the optional peer mandatory for the `@google/adk` barrel, and `instanceof`
  // fails across two copies of the SDK in one runtime.
  const summary =
    e instanceof Error && e.name === 'McpError'
      ? 'MCP tool execution failed'
      : 'Unexpected error during MCP tool execution';
  const error = `${summary}: ${formatError(e)}`;
  logger.warn(error);
  return {error};
}

/**
 * Tool names the framework itself puts on the wire. A server advertising one of
 * these would have its tool dispatched in place of the framework's own, so the
 * name is refused at construction.
 */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
]);

/**
 * How many times session setup is attempted. Only setup is retried: nothing has
 * reached the server yet, so a second attempt cannot repeat a tool call.
 */
const SESSION_SETUP_ATTEMPTS = 2;

/** A progress notification from a long-running MCP tool call. */
export type McpProgressCallback = (progress: Progress) => void | Promise<void>;

/** Builds a per-invocation progress callback from the runtime context. */
export type McpProgressCallbackFactory = (
  toolName: string,
  options: {callbackContext: Context},
) => McpProgressCallback | undefined;

/** Optional configuration for an {@link MCPTool}. */
export interface McpToolOptions {
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;
  /** The credential that satisfies {@link McpToolOptions.authScheme}. */
  authCredential?: AuthCredential;
  /** Key under which the resolved credential is cached in session state. */
  credentialKey?: string;
  /** Whether a human must approve the call before it runs. */
  requireConfirmation?:
    | boolean
    | ((
        args: Record<string, unknown>,
        toolContext: Context,
      ) => boolean | Promise<boolean>);
  /** Extra headers resolved per call, applied on top of the auth headers. */
  headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Receives the server's progress notifications for every call. */
  progressCallback?: McpProgressCallback;
  /** Builds a progress callback per call. Mutually exclusive with the above. */
  progressCallbackFactory?: McpProgressCallbackFactory;
}

/**
 * Derives the request headers an MCP call must carry from a credential.
 *
 * @param credential The resolved credential, when there is one.
 * @param authScheme The scheme the tool was configured with.
 * @return The headers, or undefined when the credential implies none.
 * @throws If an API key is configured without a header-based scheme.
 */
function authHeaders(
  credential: AuthCredential | undefined,
  authScheme: AuthScheme | undefined,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    return {Authorization: `Bearer ${credential.oauth2.accessToken}`};
  }
  if (credential.http) {
    return httpAuthHeaders(credential.http);
  }
  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }
  if (credential.serviceAccount) {
    logger.warn(
      'Service account credentials should be exchanged before MCP session creation',
    );
  }
  return undefined;
}

/** Derives the headers for an HTTP-scheme credential. */
function httpAuthHeaders(
  http: NonNullable<AuthCredential['http']>,
): Record<string, string> | undefined {
  const {scheme, credentials, additionalHeaders} = http;
  let headers: Record<string, string> | undefined;
  switch (scheme.toLowerCase()) {
    case 'bearer':
      if (credentials.token) {
        headers = {Authorization: `Bearer ${credentials.token}`};
      }
      break;
    case 'basic':
      if (credentials.username && credentials.password) {
        const encoded = Buffer.from(
          `${credentials.username}:${credentials.password}`,
          'utf8',
        ).toString('base64');
        headers = {Authorization: `Basic ${encoded}`};
      }
      break;
    default:
      if (credentials.token) {
        // The configured spelling is kept: an RFC 7235 scheme name is
        // case-insensitive, but servers in the wild compare it literally.
        headers = {Authorization: `${scheme} ${credentials.token}`};
      }
      break;
  }
  if (additionalHeaders) {
    headers = {...headers, ...additionalHeaders};
  }
  return headers;
}

/** Derives the headers for an API key credential. */
function apiKeyHeaders(
  apiKey: string,
  authScheme: AuthScheme | undefined,
): Record<string, string> {
  if (!authScheme) {
    // The key itself is never named here: the message reaches logs and the
    // model.
    const message =
      'Cannot find corresponding auth scheme for API key credential.';
    logger.error(message);
    throw new Error(message);
  }
  if (authScheme.type === 'apiKey' && authScheme.in === 'header') {
    return {[authScheme.name]: apiKey};
  }
  const location = authScheme.type === 'apiKey' ? authScheme.in : undefined;
  const message =
    'McpTool only supports header-based API key authentication. ' +
    `Configured location: ${location}`;
  logger.error(message);
  throw new Error(message);
}

/**
 * Calls a tool, failing the moment the transport dies under it.
 *
 * A crashed transport never answers, so an unguarded call waits out the read
 * timeout — five minutes by default. The client's `onerror` and `onclose`
 * handlers are the only notice of the crash, so the call races them, and the
 * previous handlers are restored afterwards.
 *
 * @param session The connected MCP client.
 * @param params The `tools/call` parameters.
 * @param options The per-request options.
 * @return The tool result.
 */
async function callGuarded(
  session: Client,
  params: CallToolRequest['params'],
  options: {signal?: AbortSignal; onprogress?: McpProgressCallback},
): Promise<CallToolResult> {
  const previousOnError = session.onerror;
  const previousOnClose = session.onclose;
  try {
    const crashed = new Promise<never>((_, reject) => {
      session.onerror = (error: Error) => {
        previousOnError?.(error);
        reject(error);
      };
      session.onclose = () => {
        previousOnClose?.();
        reject(
          new Error('MCP transport closed while the tool call was in flight.'),
        );
      };
    });
    const result = await Promise.race([
      session.callTool(params, undefined, options),
      crashed,
    ]);
    return result as CallToolResult;
  } finally {
    session.onerror = previousOnError;
    session.onclose = previousOnClose;
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
 *
 * A failed call is reported to the model as an `{error}` result, so a server
 * that rejects one call does not end the agent turn. Disable the
 * {@link FeatureName.MCP_GRACEFUL_ERROR_HANDLING} feature to make the failure
 * throw instead. A cancelled call always throws.
 *
 * {@link McpToolOptions} adds authentication, a human-approval gate, per-call
 * headers and progress notifications. With no options the call behaves exactly
 * as it did before those options existed.
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
    if (RESERVED_TOOL_NAMES.has(mcpTool.name)) {
      throw new Error(
        `MCP tool name '${mcpTool.name}' collides with a reserved ADK tool name.`,
      );
    }
    if (options.progressCallback && options.progressCallbackFactory) {
      throw new Error(
        'Configure either progressCallback or progressCallbackFactory, not both.',
      );
    }
    super({name: mcpTool.name, description: mcpTool.description || ''});
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

  /**
   * Whether this call is gated on human approval — the static flag, or the
   * predicate evaluated against the arguments.
   *
   * The resume path asks the same question a turn later, to check that an
   * approval it is about to honour belongs to a tool that gates at all. A gated
   * MCP call can only be approved because this override answers it.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    const requireConfirmation = this.options.requireConfirmation ?? false;
    if (typeof requireConfirmation !== 'function') {
      return requireConfirmation;
    }
    if (!toolContext) {
      throw new Error(
        `Tool '${this.name}' requires confirmation but no tool context was provided.`,
      );
    }
    return requireConfirmation(args, toolContext);
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const gate = await this.checkConfirmation(
      request.args,
      request.toolContext,
    );
    if (gate !== undefined) {
      return gate;
    }
    try {
      return await this.callMcpTool(request);
    } catch (e: unknown) {
      if (
        !isFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING) ||
        isCancellation(e, request.toolContext.abortSignal)
      ) {
        throw e;
      }
      return toErrorResult(e);
    }
  }

  /**
   * Evaluates the confirmation gate. Returns `undefined` if the tool may
   * proceed; otherwise returns the function response payload to surface instead
   * of running.
   */
  private async checkConfirmation(
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<{error: string} | undefined> {
    if (!(await this.checkRequireConfirmation(args, toolContext))) {
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

  /** Authenticates the call, opens a session, calls the tool and closes it. */
  private async callMcpTool(request: RunAsyncToolRequest): Promise<unknown> {
    const {toolContext} = request;
    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      this.options.authScheme,
      this.options.authCredential,
      {credentialKey: this.options.credentialKey},
    );
    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    // Without a scheme the handler has nothing to resolve and returns no
    // credential, so the configured one is used as it stands.
    const headers = await this.resolveHeaders(
      toolContext,
      authResult.authCredential ?? this.options.authCredential,
    );
    const progressCallback = this.resolveProgressCallback(toolContext);
    const session = await this.openSession(toolContext, headers);

    try {
      return await callGuarded(
        session,
        {name: this.originalName, arguments: request.args},
        {
          signal: toolContext.abortSignal,
          ...(progressCallback ? {onprogress: progressCallback} : {}),
        },
      );
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Opens a session, retrying setup once. Nothing has reached the server at
   * this point, so a retry cannot repeat a tool call. A caller that already
   * aborted gets its failure straight back.
   */
  private async openSession(
    toolContext: Context,
    headers: Record<string, string> | undefined,
  ): Promise<Client> {
    for (let attempt = 1; attempt < SESSION_SETUP_ATTEMPTS; attempt++) {
      try {
        return await this.mcpSessionManager.createSession({headers});
      } catch (err: unknown) {
        if (toolContext.abortSignal?.aborted) {
          throw err;
        }
        logger.debug(`Retrying MCP session setup for ${this.name}.`);
      }
    }
    return this.mcpSessionManager.createSession({headers});
  }

  /** Merges the auth headers with the dynamic ones, which win a collision. */
  private async resolveHeaders(
    toolContext: Context,
    credential: AuthCredential | undefined,
  ): Promise<Record<string, string> | undefined> {
    const fromAuth = authHeaders(credential, this.options.authScheme);
    const fromProvider = await this.options.headerProvider?.(
      new ReadonlyContext(toolContext.invocationContext),
    );
    if (!fromAuth && !fromProvider) {
      // Undefined, not `{}`: the transport keeps its own configured headers.
      return undefined;
    }
    return {...fromAuth, ...fromProvider};
  }

  /** The progress callback for this invocation, direct or from the factory. */
  private resolveProgressCallback(
    toolContext: Context,
  ): McpProgressCallback | undefined {
    if (this.options.progressCallbackFactory) {
      return this.options.progressCallbackFactory(this.name, {
        callbackContext: toolContext,
      });
    }
    return this.options.progressCallback;
  }
}
