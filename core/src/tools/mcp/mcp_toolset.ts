/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {buildAuthHeaders} from '../../auth/auth_headers.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

/**
 * Slot the exchanged MCP credential is stored under when the caller names no
 * `credentialKey`, following the OpenAPI toolset's `default_openapi_key`.
 */
const DEFAULT_MCP_CREDENTIAL_KEY = 'default_mcp_key';

/**
 * Resolves request headers immediately before an MCP session is created.
 *
 * Called once per `getTools()` call. The headers it returns are reused by every
 * tool that call returns, for as long as those tools live, so a credential that
 * expires mid-conversation is not re-minted. Returned headers are merged
 * over any static headers in
 * `StreamableHTTPConnectionParams.transportOptions.requestInit.headers`; on key
 * conflict the provider wins. Headers are only meaningful for HTTP transports —
 * they are ignored for `StdioConnectionParams`.
 *
 * The context is absent on the resource calls, which carry none, so a provider
 * must not dereference it unconditionally.
 */
export type MCPHeaderProvider = (
  context?: ReadonlyContext,
) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Configures an {@link MCPToolset}.
 *
 * Prefer this over the positional constructor: an MCP server that needs both
 * headers and a credential is otherwise configured through four trailing
 * positional arguments.
 */
export interface MCPToolsetOptions {
  /** How to reach the MCP server. */
  connectionParams: MCPConnectionParams;
  /** Selects the tools this toolset exposes. Defaults to no filter. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended as `${prefix}_` to every discovered tool name. */
  prefix?: string;
  /** Resolves extra request headers before each MCP session is created. */
  headerProvider?: MCPHeaderProvider;
  /**
   * The scheme the MCP server authenticates with. Supplying it makes
   * {@link MCPToolset.getAuthConfig} return an auth config.
   */
  authScheme?: AuthScheme;
  /** The raw credential to exchange for the scheme above. */
  authCredential?: AuthCredential;
  /**
   * Names the slot the exchanged credential is stored under. Defaults to
   * `default_mcp_key`.
   */
  credentialKey?: string;
}

/**
 * Finds the advertised resource called `name`.
 *
 * @throws If the server advertises no resource under that name.
 */
function findResource(resources: Resource[], name: string): Resource {
  const resource = resources.find((candidate) => candidate.name === name);
  if (!resource) {
    throw new Error(`Resource with name '${name}' not found.`);
  }
  return resource;
}

/**
 * Reads the options out of either constructor form.
 *
 * The forms are told apart by `type`: every `MCPConnectionParams` member
 * carries it and {@link MCPToolsetOptions} never does.
 *
 * @throws If the connection params are missing.
 */
function normalizeToolsetOptions(
  optionsOrConnectionParams: MCPToolsetOptions | MCPConnectionParams,
  toolFilter: ToolPredicate | string[],
  prefix?: string,
): MCPToolsetOptions {
  const options =
    optionsOrConnectionParams && 'type' in optionsOrConnectionParams
      ? {connectionParams: optionsOrConnectionParams, toolFilter, prefix}
      : optionsOrConnectionParams;

  if (!options?.connectionParams) {
    throw new Error('Missing connection params in MCPToolset.');
  }
  return options;
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
 * For servers that require short-lived credentials, pass an
 * {@link MCPHeaderProvider}: it is invoked on every `getTools()` call and its
 * headers are merged over the connection's static headers for the discovery
 * session and for every tool call made by the returned tools. Headers only
 * apply to HTTP transports; they are ignored for stdio connections.
 *
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly headerProvider?: MCPHeaderProvider;
  private readonly authConfig?: AuthConfig;

  constructor(options: MCPToolsetOptions);
  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter?: ToolPredicate | string[],
    prefix?: string,
  );
  constructor(
    optionsOrConnectionParams: MCPToolsetOptions | MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    const options = normalizeToolsetOptions(
      optionsOrConnectionParams,
      toolFilter,
      prefix,
    );
    super(options.toolFilter ?? [], options.prefix);
    this.mcpSessionManager = new MCPSessionManager(options.connectionParams);
    this.headerProvider = options.headerProvider;
    this.authConfig = options.authScheme
      ? {
          authScheme: options.authScheme,
          rawAuthCredential: options.authCredential,
          credentialKey: options.credentialKey || DEFAULT_MCP_CREDENTIAL_KEY,
        }
      : undefined;
    if (options.authCredential && !this.authConfig) {
      logger.warn(
        'MCPToolset: authCredential was given without authScheme, so the ' +
          'toolset sends no auth header. Pass authScheme to authenticate.',
      );
    }
  }

  /**
   * Returns the auth config the MCP server is reached with.
   *
   * The same instance is returned on every call, so a caller can set
   * `exchangedAuthCredential` on it and have the next {@link getTools} call —
   * and every tool that call returns — send the matching header.
   *
   * That instance is shared for the toolset's lifetime, and a toolset outlives
   * every session it opens. A per-user token written onto it is therefore read
   * by every other user, so store one only on a toolset scoped to that user.
   *
   * @return The auth config, or `undefined` when no auth scheme was
   *     configured.
   */
  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  /**
   * Builds the headers one MCP session is opened with.
   *
   * Auth headers are merged over the provider's, so a credential ADK exchanged
   * wins over a header the caller hardcoded.
   */
  private async buildHeaders(
    context?: ReadonlyContext,
  ): Promise<Headers | undefined> {
    const providerHeaders = this.headerProvider
      ? await this.headerProvider(context)
      : undefined;
    // An `apiKey` or `http` scheme needs no exchange, so the configured
    // credential is used until ADK stores an exchanged one.
    const authHeaders = buildAuthHeaders(
      this.authConfig?.exchangedAuthCredential ??
        this.authConfig?.rawAuthCredential,
      this.authConfig?.authScheme,
    );

    // A provider that returns no header must leave the connection's own
    // transport options untouched, so nothing is built for an empty result.
    const count =
      Object.keys(providerHeaders ?? {}).length +
      Object.keys(authHeaders ?? {}).length;
    if (count === 0) {
      return undefined;
    }
    // `set` matches names case-insensitively, so an auth header replaces a
    // provider header of the same name rather than joining it.
    const headers = new Headers(providerHeaders);
    for (const [name, value] of Object.entries(authHeaders ?? {})) {
      headers.set(name, value);
    }
    return headers;
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers = await this.buildHeaders(context);
    const session = await this.mcpSessionManager.createSession(headers);

    let listResult: ListToolsResult;
    try {
      listResult = (await session.listTools()) as ListToolsResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
    logger.debug(`number of tools: ${listResult.tools.length}`);
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`);
    }

    const tools = listResult.tools.map((tool) => {
      // Create a cloned tool definition with the prefixed name
      const toolWithPrefix = {
        ...tool,
        name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      };
      return new MCPTool(
        toolWithPrefix,
        this.mcpSessionManager,
        tool.name,
        headers,
      );
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
    const resources = await this.listServerResources(await this.buildHeaders());
    return resources.map((resource) => resource.name);
  }

  /** Opens one session with `headers` and returns what the server advertises. */
  private async listServerResources(headers?: Headers): Promise<Resource[]> {
    const session = await this.mcpSessionManager.createSession(headers);
    try {
      const result = (await session.listResources()) as ListResourcesResult;
      return result.resources;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const resources = await this.listServerResources(await this.buildHeaders());
    return findResource(resources, name);
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
    // Headers are resolved once: a provider that mints a one-shot token must
    // not be called twice for one read.
    const headers = await this.buildHeaders();
    const resourceInfo = findResource(
      await this.listServerResources(headers),
      name,
    );
    if (!resourceInfo.uri) {
      throw new Error(`Resource '${name}' has no URI.`);
    }

    const session = await this.mcpSessionManager.createSession(headers);
    try {
      const result = (await session.readResource({
        uri: resourceInfo.uri,
      })) as ReadResourceResult;
      return result.contents;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  async close(): Promise<void> {
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
