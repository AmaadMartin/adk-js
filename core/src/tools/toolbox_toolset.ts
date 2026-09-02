/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolboxClient, ToolboxTool} from '@toolbox-sdk/core';

import {ReadonlyContext} from '../agents/readonly_context.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {BaseTool} from './base_tool.js';
import {BaseToolset, ToolPredicate} from './base_toolset.js';
import {FunctionTool} from './function_tool.js';

/** The optional peer dependency that backs {@link ToolboxToolset}. */
const TOOLBOX_SDK = {
  packageName: '@toolbox-sdk/core',
  feature: 'ToolboxToolset',
};

/**
 * A client-to-server header value: a fixed string, or a getter the SDK calls
 * for every request.
 */
export type ToolboxHeaderValue = string | (() => string | Promise<string>);

/**
 * Returns the authentication token for one auth service. The Toolbox
 * JavaScript SDK calls it per tool invocation and passes it no arguments, so —
 * unlike adk-python — the getter cannot inspect the invocation context.
 */
export type ToolboxAuthTokenGetter = () => string | Promise<string>;

/** Options for {@link ToolboxToolset}. */
export interface ToolboxToolsetOptions {
  /** Name of a toolset defined on the server; all of its tools are loaded. */
  toolsetName?: string;
  /** Names of individual tools to load, in addition to the toolset's. */
  toolNames?: string[];
  /**
   * Auth service name to token getter, applied to every loaded tool. See
   * https://github.com/googleapis/mcp-toolbox-sdk-js for the auth model.
   */
  authTokenGetters?: Record<string, ToolboxAuthTokenGetter>;
  /**
   * Parameter name to a value bound at load time, so the model neither sees
   * nor supplies it. Either a value, or a (possibly async) getter the SDK
   * calls per invocation.
   */
  boundParams?: Record<string, unknown>;
  /** Headers sent with every request to the server. */
  additionalHeaders?: Record<string, ToolboxHeaderValue>;
  /** Selects which of the loaded tools the agent sees. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended to every tool name as `${prefix}_${name}`. */
  prefix?: string;
}

/** Wraps one loaded Toolbox tool as an ADK {@link FunctionTool}. */
function toFunctionTool(tool: ToolboxTool, prefix?: string): BaseTool {
  const name = tool.getName();
  return new FunctionTool({
    name: prefix ? `${prefix}_${name}` : name,
    description: tool.getDescription(),
    parameters: tool.getParamSchema(),
    execute: (args) => tool(args),
  });
}

/**
 * Applies `filter` to `tools`. A predicate needs a {@link ReadonlyContext} to
 * be evaluated; without one every tool is returned and a warning is logged,
 * which is how `MCPToolset` handles the same case.
 */
function selectTools(
  tools: BaseTool[],
  filter: ToolPredicate | string[],
  context?: ReadonlyContext,
): BaseTool[] {
  if (Array.isArray(filter)) {
    return filter.length === 0
      ? tools
      : tools.filter((tool) => filter.includes(tool.name));
  }
  if (!context) {
    logger.warn(
      'ToolboxToolset: a ToolPredicate toolFilter was provided but ' +
        'getTools() was called without a ReadonlyContext. The filter will ' +
        'not be applied.',
    );
    return tools;
  }
  return tools.filter((tool) => filter(tool, context));
}

/**
 * A toolset backed by an MCP Toolbox for Databases server.
 *
 * Each tool published by the server becomes a {@link FunctionTool}, so an
 * agent calls it like any other ADK tool. Nothing is fetched until the first
 * `getTools()` call, and nothing is cached between calls: the tool list is
 * re-read from the server every time.
 *
 * ```ts
 * import {LlmAgent, ToolboxToolset} from '@google/adk';
 *
 * const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
 *   toolsetName: 'hotel-tools',
 * });
 * const agent = new LlmAgent({
 *   name: 'hotel_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [toolbox],
 * });
 * ```
 *
 * `toolsetName` and `toolNames` are both optional. When `toolsetName` is
 * given, the toolset's tools come first; the tools named by `toolNames`
 * follow, in the order given. A tool reachable both ways appears twice. When
 * neither is given, every tool the server publishes is loaded.
 *
 * adk-python takes a `credentials` object for client-to-server authentication.
 * The JavaScript SDK has no equivalent; send a credential as a header instead,
 * for example with `getGoogleIdToken` from `@toolbox-sdk/core/auth`:
 *
 * ```ts
 * const toolbox = new ToolboxToolset('https://toolbox.example.com', {
 *   additionalHeaders: {'X-Api-Key': async () => await fetchKey()},
 * });
 * ```
 *
 * Requires the optional peer dependency `@toolbox-sdk/core`.
 */
export class ToolboxToolset extends BaseToolset {
  private readonly options: ToolboxToolsetOptions;
  private clientPromise?: Promise<ToolboxClient>;

  /**
   * @param serverUrl The URL of the Toolbox server, e.g.
   *   `http://127.0.0.1:5000`.
   * @param options Which tools to load and how to reach them.
   */
  constructor(
    private readonly serverUrl: string,
    options: ToolboxToolsetOptions = {},
  ) {
    super(options.toolFilter ?? [], options.prefix);
    this.options = options;
  }

  /**
   * Resolves the Toolbox client, loading the `@toolbox-sdk/core` optional peer
   * on first use. The promise is cached, so concurrent first calls share one
   * client.
   */
  private getClient(): Promise<ToolboxClient> {
    this.clientPromise ??= loadOptionalPeer(TOOLBOX_SDK, async () => {
      const {ToolboxClient} = await import('@toolbox-sdk/core');
      return new ToolboxClient(
        this.serverUrl,
        null,
        this.options.additionalHeaders,
      );
    });
    return this.clientPromise;
  }

  /**
   * Loads the server's tools and returns the ones the filter selects.
   *
   * @param context Context a predicate `toolFilter` is evaluated against.
   * @return The loaded tools, prefixed and filtered.
   * @throws If `@toolbox-sdk/core` is not installed, or if the server rejects
   *   a load — an unknown tool or toolset name, or an auth token getter or
   *   bound parameter that no loaded tool uses.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const client = await this.getClient();
    const {toolsetName, authTokenGetters, boundParams} = this.options;
    const toolNames = this.options.toolNames ?? [];

    const loaded: ToolboxTool[] = [];
    // No named tools and no toolset name means "load everything", which the
    // server answers as its default toolset.
    if (toolsetName !== undefined || toolNames.length === 0) {
      loaded.push(
        ...(await client.loadToolset(
          toolsetName,
          authTokenGetters,
          boundParams,
        )),
      );
    }
    for (const name of toolNames) {
      loaded.push(await client.loadTool(name, authTokenGetters, boundParams));
    }

    const tools = loaded.map((tool) => toFunctionTool(tool, this.prefix));
    return selectTools(tools, this.toolFilter, context);
  }

  /**
   * Releases the cached client. The Toolbox client holds no connection of its
   * own, so this only drops the reference: a later `getTools()` builds a new
   * client, and calling `close()` twice is safe.
   */
  async close(): Promise<void> {
    this.clientPromise = undefined;
  }
}
