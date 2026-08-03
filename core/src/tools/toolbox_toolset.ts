/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {
  ToolboxClient as ToolboxSdkClient,
  ToolboxTool as ToolboxSdkTool,
} from '@toolbox-sdk/adk';

import {ReadonlyContext} from '../agents/readonly_context.js';

import {BaseTool, RunAsyncToolRequest} from './base_tool.js';
import {BaseToolset} from './base_toolset.js';

/** The npm package that backs {@link ToolboxToolset}. */
const TOOLBOX_SDK_PACKAGE = '@toolbox-sdk/adk';

/**
 * Produces an authentication token for a single named auth source.
 *
 * The getter is handed to the toolbox SDK, which invokes it on every tool
 * call, so a short-lived token can be refreshed between calls.
 */
export type ToolboxAuthTokenGetter = () => string | Promise<string>;

/**
 * A value bound to a tool parameter: either a literal, or a callable that
 * produces one when the tool is invoked.
 */
export type ToolboxBoundValue =
  | unknown
  | (() => unknown)
  | (() => Promise<unknown>);

/**
 * Options for {@link ToolboxToolset}.
 *
 * `toolsetName` and `toolNames` are both optional selectors. If both are
 * omitted, every tool on the server is loaded.
 */
export interface ToolboxToolsetOptions {
  /**
   * The name of a toolset defined on the server. Its tools are loaded in
   * addition to any listed in {@link ToolboxToolsetOptions.toolNames}.
   */
  toolsetName?: string;

  /**
   * Names of individual tools to load, in addition to any loaded through
   * {@link ToolboxToolsetOptions.toolsetName}.
   */
  toolNames?: string[];

  /**
   * Maps an auth source name to a getter returning its token. See
   * https://github.com/googleapis/mcp-toolbox-sdk-js/tree/main/packages/toolbox-core#authenticating-tools
   */
  authTokenGetters?: Record<string, ToolboxAuthTokenGetter>;

  /**
   * Maps a tool parameter name to a value that is pre-filled on every call
   * and hidden from the model. See
   * https://github.com/googleapis/mcp-toolbox-sdk-js/tree/main/packages/toolbox-core#binding-parameter-values
   */
  boundParams?: Record<string, ToolboxBoundValue>;

  /** Static headers sent with every request to the toolbox server. */
  additionalHeaders?: Record<string, string>;
}

/**
 * Adapts a toolbox SDK tool to the ADK {@link BaseTool} contract.
 *
 * The SDK ships its own `BaseTool` subclass, but it extends the `BaseTool`
 * of whichever `@google/adk` copy the SDK resolved, which is not necessarily
 * this one. Wrapping keeps `getTools()` returning tools branded by this
 * package.
 */
class ToolboxTool extends BaseTool {
  constructor(private readonly sdkTool: ToolboxSdkTool) {
    super({
      name: sdkTool.getCoreTool().toolName,
      description: sdkTool.getCoreTool().description,
    });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.sdkTool._getDeclaration();
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.sdkTool.getCoreTool()(request.args);
  }
}

/**
 * A toolset that exposes the tools served by an MCP Toolbox for Databases
 * server.
 *
 * The toolset is a thin adapter over the `@toolbox-sdk/adk` package, which
 * must be installed alongside `@google/adk` (it is declared as an optional
 * peer dependency). Tools are re-listed on every {@link getTools} call, so a
 * server-side change is picked up without recreating the toolset.
 *
 * Usage:
 * ```ts
 * import {LlmAgent, ToolboxToolset} from '@google/adk';
 *
 * const toolbox = new ToolboxToolset('http://127.0.0.1:5000');
 * const agent = new LlmAgent({
 *   name: 'hotel_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [toolbox],
 * });
 * ```
 */
export class ToolboxToolset extends BaseToolset {
  private client?: ToolboxSdkClient;

  /**
   * @param serverUrl The base URL of the toolbox server, used verbatim.
   * @param options Selection, auth, binding and header options.
   */
  constructor(
    private readonly serverUrl: string,
    private readonly options: ToolboxToolsetOptions = {},
  ) {
    super([]);
  }

  /**
   * Returns the memoised toolbox client, creating it on first use.
   *
   * @throws If the optional `@toolbox-sdk/adk` peer is not installed.
   */
  private async getClient(): Promise<ToolboxSdkClient> {
    if (!this.client) {
      let sdk: typeof import('@toolbox-sdk/adk');
      try {
        sdk = await import('@toolbox-sdk/adk');
      } catch (cause) {
        throw new Error(
          `ToolboxToolset requires the '${TOOLBOX_SDK_PACKAGE}' package. ` +
            `Install it with \`npm install ${TOOLBOX_SDK_PACKAGE}\`.`,
          {cause},
        );
      }
      this.client = new sdk.ToolboxClient(
        this.serverUrl,
        null,
        this.options.additionalHeaders,
      );
    }
    return this.client;
  }

  /**
   * Loads the selected tools from the toolbox server.
   *
   * Tool selection happens server-side, so `context` is accepted for
   * interface compatibility and ignored.
   *
   * @param _context Unused; selection is driven by the constructor options.
   * @return The named toolset's tools followed by the individually named
   *     tools.
   */
  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    const client = await this.getClient();
    const {toolsetName, toolNames, authTokenGetters, boundParams} =
      this.options;
    const sdkTools: ToolboxSdkTool[] = [];

    if (toolsetName !== undefined || !toolNames?.length) {
      sdkTools.push(
        ...(await client.loadToolset(
          toolsetName,
          authTokenGetters,
          boundParams,
        )),
      );
    }
    if (toolNames?.length) {
      sdkTools.push(
        ...(await Promise.all(
          toolNames.map((name) =>
            client.loadTool(name, authTokenGetters, boundParams),
          ),
        )),
      );
    }
    return sdkTools.map((sdkTool) => new ToolboxTool(sdkTool));
  }

  /**
   * Closes the toolset.
   *
   * The toolbox client holds no releasable resource, so this resolves
   * immediately.
   */
  override async close(): Promise<void> {}
}
