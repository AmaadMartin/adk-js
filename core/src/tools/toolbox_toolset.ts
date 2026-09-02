/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolboxClient, ToolboxTool} from '@toolbox-sdk/core';
import type {ZodObject, ZodRawShape} from 'zod';

import {ReadonlyContext} from '../agents/readonly_context.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {BaseTool} from './base_tool.js';
import {BaseToolset} from './base_toolset.js';
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
}

/** Wraps a tool loaded from the toolbox server as an ADK tool. */
function toFunctionTool(
  tool: ToolboxTool,
): FunctionTool<ZodObject<ZodRawShape>> {
  return new FunctionTool({
    name: tool.getName(),
    description: tool.getDescription(),
    parameters: tool.getParamSchema(),
    execute: (args) => tool(args),
  });
}

/**
 * A toolset backed by an MCP Toolbox for Databases server.
 *
 * The server publishes tools, either grouped into named toolsets or addressed
 * one by one. This toolset loads them over HTTP and exposes each one to the
 * agent as a {@link FunctionTool}. Give a `toolsetName`, a list of `toolNames`,
 * or both; at least one is required.
 *
 * The server is reached through the optional peer dependency
 * `@toolbox-sdk/core`, which the application installs itself. The package is
 * loaded on the first {@link ToolboxToolset.getTools} call, because a dynamic
 * `import()` cannot be awaited in a constructor. Constructing a toolset
 * therefore does no I/O, and a missing package surfaces on that first call.
 * Python builds its client eagerly in `__init__`; this is the one behavioural
 * difference the language forces.
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
    super([]);
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
   * @return The toolset's tools first, then the tools named in `toolNames`, in
   *     the order given.
   */
  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    const client = await this.getClient();
    const [toolsetTools, namedTools] = await Promise.all([
      this.toolsetName ? client.loadToolset(this.toolsetName) : [],
      Promise.all(this.toolNames.map((name) => client.loadTool(name))),
    ]);
    return [...toolsetTools, ...namedTools].map(toFunctionTool);
  }

  /**
   * Resolves immediately, and leaves the toolset usable.
   *
   * Python closes its `ToolboxSyncClient` here. The JavaScript `ToolboxClient`
   * exposes no `close()`: it talks to the server over one HTTP request per
   * call and holds nothing that outlives a request, so there is no resource to
   * release.
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
