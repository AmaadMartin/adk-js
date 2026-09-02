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

/** Options for {@link ToolboxToolset}. */
export interface ToolboxToolsetOptions {
  /** Name of a toolset defined on the server; all of its tools are loaded. */
  toolsetName?: string;
  /** Names of individual tools to load, in addition to the toolset's. */
  toolNames?: string[];
  /** Selects which of the loaded tools the agent sees. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended to every tool name as `${prefix}_${name}`. */
  prefix?: string;
}

/** Wraps a tool loaded from the toolbox server as an ADK tool. */
function toFunctionTool(tool: ToolboxTool, prefix?: string) {
  const name = tool.getName();
  return new FunctionTool({
    name: prefix ? `${prefix}_${name}` : name,
    description: tool.getDescription(),
    parameters: tool.getParamSchema(),
    execute: (args) => tool(args),
  });
}

/**
 * Keeps the tools the filter selects, matching names after the prefix.
 *
 * A predicate needs a context to run. Without one, every tool is kept and the
 * caller is warned, so a filter is never dropped in silence.
 */
function selectTools(
  tools: BaseTool[],
  filter: ToolPredicate | string[],
  context?: ReadonlyContext,
): BaseTool[] {
  if (typeof filter === 'function') {
    if (!context) {
      logger.warn(
        'ToolboxToolset: toolFilter is a predicate, but getTools() received ' +
          'no ReadonlyContext. The filter was not applied.',
      );
      return tools;
    }
    return tools.filter((tool) => filter(tool, context));
  }
  return filter.length === 0
    ? tools
    : tools.filter((tool) => filter.includes(tool.name));
}

/**
 * A toolset backed by an MCP Toolbox for Databases server.
 *
 * The server publishes tools, either grouped into named toolsets or addressed
 * one by one. This toolset loads them over HTTP and exposes each one to the
 * agent as a {@link FunctionTool}. Give a `toolsetName`, a list of `toolNames`,
 * or both; at least one is required. A `prefix` renames every tool, and a
 * `toolFilter` narrows the list the agent sees.
 *
 * The server is reached through the optional peer dependency
 * `@toolbox-sdk/core`, which the application installs itself. The package is
 * loaded on the first {@link ToolboxToolset.getTools} call, because a dynamic
 * `import()` cannot be awaited in a constructor. Constructing a toolset
 * therefore does no I/O, and a missing package surfaces on that first call.
 *
 * ```ts
 * const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
 *   toolsetName: 'my-toolset',
 * });
 * const agent = new LlmAgent({
 *   name: 'hotel_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [toolbox],
 * });
 * ```
 */
export class ToolboxToolset extends BaseToolset {
  private readonly serverUrl: string;
  private readonly toolsetName?: string;
  private readonly toolNames: string[];
  private clientPromise?: Promise<ToolboxClient>;

  /**
   * @param serverUrl Base URL of the toolbox server, e.g.
   *     `http://127.0.0.1:5000`.
   * @param options Which tools to load from that server.
   * @throws If neither `toolsetName` nor a non-empty `toolNames` is given.
   */
  constructor(serverUrl: string, options: ToolboxToolsetOptions = {}) {
    if (!options.toolsetName && !options.toolNames?.length) {
      throw new Error('toolNames and toolsetName cannot both be empty');
    }
    super(options.toolFilter ?? [], options.prefix);
    this.serverUrl = serverUrl;
    this.toolsetName = options.toolsetName;
    this.toolNames = options.toolNames ?? [];
  }

  /**
   * Loads the configured tools from the server.
   *
   * The list is fetched on every call rather than cached, so a tool added on
   * the server is picked up. Errors raised by the server or by the transport
   * propagate unchanged.
   *
   * @param context Evaluates a {@link ToolPredicate} filter. A string-array
   *     filter needs no context.
   * @return The toolset's tools first, then the tools named in `toolNames`, in
   *     the order given, minus the ones the filter rejects.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const client = await this.getClient();
    const [toolsetTools, namedTools] = await Promise.all([
      this.toolsetName ? client.loadToolset(this.toolsetName) : [],
      Promise.all(this.toolNames.map((name) => client.loadTool(name))),
    ]);
    const tools = [...toolsetTools, ...namedTools].map((tool) =>
      toFunctionTool(tool, this.prefix),
    );
    return selectTools(tools, this.toolFilter, context);
  }

  /**
   * Resolves immediately, and leaves the toolset usable.
   *
   * `ToolboxClient` exposes no `close()`: it talks to the server over one HTTP
   * request per call and holds nothing that outlives a request, so there is no
   * resource to release.
   */
  override async close(): Promise<void> {}

  /** Resolves the client, creating it once per toolset. */
  private getClient(): Promise<ToolboxClient> {
    this.clientPromise ??= loadOptionalPeer(
      TOOLBOX_SDK,
      () => import('@toolbox-sdk/core'),
    ).then(({ToolboxClient}) => new ToolboxClient(this.serverUrl));
    return this.clientPromise;
  }
}
