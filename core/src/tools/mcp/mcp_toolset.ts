/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
} from '../../agents/framework_function_calls.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {formatError, isAbortError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {retryOnce} from '../../utils/retry_utils.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {
  MCP_CONNECTION_ERROR_NAME,
  McpConnectionError,
  MCPConnectionParams,
  MCPSessionManager,
} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

/**
 * Tool names the ADK framework owns.
 *
 * An MCP server that advertises one of these would shadow a framework function
 * call, so the toolset drops it instead of exposing it to the model.
 */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
]);

/**
 * Whether `err` is an {@link McpConnectionError}.
 *
 * `name` is matched rather than the class, so the check still holds when two
 * copies of the package share one runtime.
 */
function isMcpConnectionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === MCP_CONNECTION_ERROR_NAME
  );
}

/**
 * Names the MCP operation that produced `err`, so a bare transport string
 * reaches the caller as `<operation>: <root cause>`.
 *
 * A cancellation passes through untouched: the caller has to keep seeing an
 * `AbortError` rather than a connection failure. An {@link McpConnectionError}
 * also passes through, because it already names an operation.
 */
function nameFailedOperation(operation: string, err: unknown): unknown {
  if (isAbortError(err) || isMcpConnectionError(err)) {
    return err;
  }
  return new McpConnectionError(`${operation}: ${formatError(err)}`, {
    cause: err,
  });
}

/**
 * The trailing `RequestOptions` argument of an MCP call, as a spreadable
 * tuple: empty when no timeout is configured, so the call reaches the SDK
 * exactly as it did before and takes the SDK's own default deadline.
 *
 * The SDK cancels a request that outlives its timeout — it sends
 * `notifications/cancelled` to the server and rejects with an `McpError` — so
 * the deadline belongs to the SDK rather than to a race around it.
 *
 * @param timeoutSeconds The configured deadline in seconds, if there is one.
 * @return The argument tuple to spread into an SDK call.
 */
function callOptions(
  timeoutSeconds: number | undefined,
): [RequestOptions] | [] {
  return timeoutSeconds === undefined ? [] : [{timeout: timeoutSeconds * 1000}];
}

/**
 * A toolset that dynamically discovers and provides tools from a Model Context
 * Protocol (MCP) server.
 *
 * This class connects to an MCP server, retrieves the list of available tools,
 * and wraps each of them in an {@link MCPTool} instance. This allows the agent
 * to seamlessly use tools from an external MCP-compliant service.
 *
 * The toolset can be configured with a filter to selectively expose a subset
 * of the tools provided by the MCP server.
 *
 * It can also be configured with a prefix. If provided, all tools discovered
 * from the MCP server will have their names prefixed with `${prefix}_`. When the
 * LLM invokes the prefixed tool, this toolset transparently strips the prefix
 * before sending the request to the underlying MCP server.
 *
 * Usage:
 *   import { MCPToolset } from '@google/adk';
 *   import { StreamableHTTPConnectionParamsSchema } from '@google/adk';
 *
 *   const connectionParams = StreamableHTTPConnectionParamsSchema.parse({
 *     type: "StreamableHTTPConnectionParams",
 *     url: "http://localhost:8788/mcp"
 *   });
 *
 *   const mcpToolset = new MCPToolset(connectionParams);
 *   const tools = await mcpToolset.getTools();
 *
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  /** Carries `connectionParams.timeout` into every call this toolset makes. */
  private readonly callOptions: [RequestOptions] | [];

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    super(toolFilter, prefix);
    this.callOptions = callOptions(connectionParams.timeout);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  /**
   * Opens a session, runs `run` on it, and closes it again.
   *
   * This is the single place a failed MCP call is turned into an
   * {@link McpConnectionError}: `operation` names what was being attempted, so
   * the caller learns which MCP call failed instead of reading a bare
   * transport string. The session is closed on every exit path.
   *
   * @param operation Short description of the attempt, used as the message
   *   prefix on failure.
   * @param run Receives the open session.
   * @return Whatever `run` resolves to.
   * @throws {McpConnectionError} when opening the session or running `run`
   *   fails for any reason other than cancellation.
   */
  private async executeWithSession<T>(
    operation: string,
    run: (session: Client) => Promise<T>,
  ): Promise<T> {
    let session: Client | undefined;
    try {
      session = await this.mcpSessionManager.createSession();
      return await run(session);
    } catch (err: unknown) {
      throw nameFailedOperation(operation, err);
    } finally {
      if (session) {
        await this.mcpSessionManager.closeSession(session);
      }
    }
  }

  /**
   * Returns the tools the MCP server advertises.
   *
   * A failed listing is retried once: `tools/list` is idempotent, so a second
   * attempt costs a round trip and cannot duplicate a side effect.
   *
   * @param context Context used to filter the tools available to the agent.
   * @return The tools that survive the reserved-name skip and the tool filter.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return retryOnce(() => this.listAndBuildTools(context), 'MCP getTools');
  }

  /** Lists the server's tools once and wraps them as {@link MCPTool}s. */
  private async listAndBuildTools(
    context?: ReadonlyContext,
  ): Promise<BaseTool[]> {
    const listResult = await this.executeWithSession(
      'Failed to get tools from MCP server',
      async (session) =>
        (await session.listTools(
          undefined,
          ...this.callOptions,
        )) as ListToolsResult,
    );

    logger.debug(`number of tools: ${listResult.tools.length}`);
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`);
    }

    const tools = listResult.tools
      // Skip rather than expose: a reserved name would shadow a framework
      // function call, and dropping one tool beats failing the whole listing.
      .filter((tool) => {
        if (!RESERVED_TOOL_NAMES.has(tool.name)) {
          return true;
        }
        logger.warn(
          `Skipping MCP tool '${tool.name}' because it collides with a ` +
            'reserved ADK framework tool name.',
        );
        return false;
      })
      .map((tool) => {
        // Create a cloned tool definition with the prefixed name
        const toolWithPrefix = {
          ...tool,
          name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
        };
        return new MCPTool(toolWithPrefix, this.mcpSessionManager, tool.name);
      });

    // Apply toolFilter when specified.
    // An empty array (the default) means no filter — all tools are returned.
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }

    if (Array.isArray(filter)) {
      // String-array filter: match against the (possibly-prefixed) tool name.
      return tools.filter((tool) => (filter as string[]).includes(tool.name));
    }

    if (context) {
      // Predicate filter: requires a ReadonlyContext to evaluate.
      return tools.filter((tool) => filter(tool, context));
    }

    // Predicate filter requested but no context provided — return all tools
    // and log a warning so callers are aware the filter was not applied.
    logger.warn(
      'MCPToolset: a ToolPredicate toolFilter was provided but getTools() ' +
        'was called without a ReadonlyContext. The filter will not be applied.',
    );
    return tools;
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @return The resource names available on the server.
   */
  async listResources(): Promise<string[]> {
    const result = await this.listResourcesResult();
    return result.resources.map((resource) => resource.name);
  }

  /** Runs one `resources/list` call against the MCP server. */
  private async listResourcesResult(): Promise<ListResourcesResult> {
    return this.executeWithSession(
      'Failed to list resources from MCP server',
      async (session) =>
        (await session.listResources(
          undefined,
          ...this.callOptions,
        )) as ListResourcesResult,
    );
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const result = await this.listResourcesResult();

    const resource = result.resources.find(
      (candidate) => candidate.name === name,
    );
    if (!resource) {
      throw new Error(`Resource with name '${name}' not found.`);
    }
    return resource;
  }

  /**
   * Reads the contents of the named resource from the MCP server.
   *
   * The resource name is resolved to a URI via {@link getResourceInfo} before
   * reading. Binary contents are returned base64-encoded, exactly as provided
   * by the server (never decoded and re-encoded).
   *
   * @param name The advertised name of the resource to read.
   * @return The resource contents (text and/or base64-encoded binary).
   * @throws If the resource is unknown or has no URI.
   */
  async readResource(
    name: string,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const resourceInfo = await this.getResourceInfo(name);
    if (!resourceInfo.uri) {
      throw new Error(`Resource '${name}' has no URI.`);
    }

    const result = await this.executeWithSession(
      `Failed to get resource ${name} from MCP server`,
      async (session) =>
        (await session.readResource(
          {uri: resourceInfo.uri},
          ...this.callOptions,
        )) as ReadResourceResult,
    );
    return result.contents;
  }

  async close(): Promise<void> {
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
