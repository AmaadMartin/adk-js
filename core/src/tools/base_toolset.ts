/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
import type {AuthConfig} from '../auth/auth_tool.js';
import {LlmRequest} from '../models/llm_request.js';

import {Context} from '../agents/context.js';
import {BaseTool} from './base_tool.js';

/**
 * Function to decide whether a tool should be exposed to LLM. Toolset
 * implementer could consider whether to accept such instance in the toolset's
 * constructor and apply the predicate in getTools method.
 */
export type ToolPredicate = (
  tool: BaseTool,
  readonlyContext: ReadonlyContext,
) => boolean;

/**
 * The arguments a toolset is built from when it is declared in a config file.
 *
 * The shape is open because each toolset reads its own keys out of it.
 * Corresponds to `ToolArgsConfig` in adk-python.
 */
export type ToolArgsConfig = Record<string, unknown>;

/**
 * Returns a copy of `tool` that answers to `prefixedName`.
 *
 * The copy keeps the original's prototype, so subclass behaviour and
 * `isBaseTool` still hold, and it reports a declaration under the new name.
 * The original tool and the declaration object it owns are left untouched.
 */
function withPrefixedName(tool: BaseTool, prefixedName: string): BaseTool {
  const copy = Object.create(Object.getPrototypeOf(tool)) as BaseTool;
  Object.assign(copy, tool, {name: prefixedName});
  copy._getDeclaration = () => {
    const declaration = tool._getDeclaration();
    return declaration ? {...declaration, name: prefixedName} : undefined;
  };
  return copy;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const BASE_TOOLSET_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseToolset');

export function isBaseToolset(obj: unknown): obj is BaseToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_TOOLSET_SIGNATURE_SYMBOL in obj &&
    obj[BASE_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Base class for toolset.
 *
 * A toolset is a collection of tools that can be used by an agent.
 */
export abstract class BaseToolset {
  readonly [BASE_TOOLSET_SIGNATURE_SYMBOL] = true;

  /**
   * Whether {@link getToolsWithPrefix} may serve a cached list for the
   * invocation it was last called in.
   *
   * A subclass whose exposed tools change within a single invocation must turn
   * this off in its constructor, or the first listing freezes for the rest of
   * the invocation.
   */
  protected useInvocationCache = true;

  private cachedInvocationId?: string;
  private cachedTools?: BaseTool[];

  constructor(
    readonly toolFilter: ToolPredicate | string[],
    readonly prefix?: string,
  ) {}

  /**
   * Returns the tools that should be exposed to LLM.
   *
   * Tools are returned unprefixed. The framework calls
   * {@link getToolsWithPrefix}, which applies {@link prefix}.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools.
   */
  abstract getTools(context?: ReadonlyContext): Promise<BaseTool[]>;

  /**
   * Returns the tools of this toolset with {@link prefix} applied to their
   * names, caching the result for the invocation it was called in.
   *
   * Both the tool name and the name in its `FunctionDeclaration` carry the
   * prefix, so a function call the model makes still routes to the tool. With
   * no prefix configured the array `getTools` returned is passed straight
   * through.
   *
   * Subclasses must not override this method; override `getTools` instead.
   * It corresponds to Python's `@final get_tools_with_prefix`.
   *
   * @param context Context used to filter tools available to the agent, and
   *     whose `invocationId` keys the cache.
   * @return A Promise that resolves to the list of prefixed tools.
   */
  async getToolsWithPrefix(context?: ReadonlyContext): Promise<BaseTool[]> {
    const invocationId = context?.invocationId;

    if (
      this.useInvocationCache &&
      this.cachedTools !== undefined &&
      this.cachedInvocationId === invocationId
    ) {
      return this.cachedTools;
    }

    const tools = await this.getTools(context);
    const prefix = this.prefix;
    const prefixedTools = prefix
      ? tools.map((tool) => withPrefixedName(tool, `${prefix}_${tool.name}`))
      : tools;

    this.cachedInvocationId = invocationId;
    this.cachedTools = prefixedTools;
    return prefixedTools;
  }

  /**
   * Closes the toolset.
   *
   * NOTE: This method is invoked, for example, at the end of an agent server's
   * lifecycle or when the toolset is no longer needed. Implementations
   * should ensure that any open connections, files, or other managed
   * resources are properly released to prevent leaks.
   *
   * @return A Promise that resolves when the toolset is closed.
   */
  async close(): Promise<void> {}

  /**
   * Creates a toolset from the arguments declared for it in a config file.
   *
   * A toolset that can be declared in a config file overrides this. The base
   * implementation throws, naming the class that failed to provide it.
   *
   * @param _config The arguments declared for the toolset.
   * @param _configAbsPath The absolute path of the config file they came from.
   * @return The toolset instance.
   */
  static fromConfig(
    _config: ToolArgsConfig,
    _configAbsPath: string,
  ): BaseToolset {
    throw new Error(`fromConfig() not implemented for toolset: ${this.name}`);
  }

  /**
   * Returns the credential ADK resolves before it lists or calls this
   * toolset's tools, or `undefined` when the toolset needs none.
   *
   * A toolset that authenticates overrides this and returns an `AuthConfig`
   * built from its auth scheme and credential. ADK populates the config's
   * `exchangedAuthCredential` field before calling {@link getTools}, so the
   * toolset can use the credential for listing as well as for calling. A tool
   * that needs a different credential requests its own through the tool
   * context.
   *
   * @return The toolset's auth config, or `undefined`.
   */
  getAuthConfig(): AuthConfig | undefined {
    return undefined;
  }

  /**
   * Returns whether the tool should be exposed to LLM.
   *
   * @param tool The tool to check.
   * @param context Context used to filter tools available to the agent.
   * @return Whether the tool should be exposed to LLM.
   */
  protected isToolSelected(tool: BaseTool, context: ReadonlyContext): boolean {
    // An empty tool filter means no filtering: all tools are selected.
    if (
      !this.toolFilter ||
      (Array.isArray(this.toolFilter) && this.toolFilter.length === 0)
    ) {
      return true;
    }

    if (typeof this.toolFilter === 'function') {
      return this.toolFilter(tool, context);
    }

    if (Array.isArray(this.toolFilter)) {
      return (this.toolFilter as string[]).includes(tool.name);
    }

    return false;
  }

  /**
   * Processes the outgoing LLM request for this toolset. This method will be
   * called before each tool processes the llm request.
   *
   * Use cases:
   * - Instead of let each tool process the llm request, we can let the toolset
   *   process the llm request. e.g. ComputerUseToolset can add computer use
   *   tool to the llm request.
   *
   * @param toolContext The context of the tool.
   * @param llmRequest The outgoing LLM request, mutable this method.
   */
  async processLlmRequest(
    toolContext: Context, // eslint-disable-line @typescript-eslint/no-unused-vars
    llmRequest: LlmRequest, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<void> {}
}
