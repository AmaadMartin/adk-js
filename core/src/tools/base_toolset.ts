/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
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
 * Returns a copy of `tool` that answers to `prefixedName`.
 *
 * The copy keeps the prototype of the original, so subclass methods still
 * work, and it shadows `_getDeclaration()` so the declaration name agrees with
 * the tool name. Neither the original tool nor its declaration is mutated.
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
 * Base class for toolset.
 *
 * A toolset is a collection of tools that can be used by an agent.
 */
export abstract class BaseToolset {
  readonly [BASE_TOOLSET_SIGNATURE_SYMBOL] = true;

  /**
   * Whether `getToolsWithPrefix()` may serve tools from its per-invocation
   * cache. Subclasses whose tool list changes within a single invocation must
   * set this to `false`.
   */
  protected useInvocationCache = true;

  private cachedInvocationId?: string;
  private cachedTools?: BaseTool[];

  /**
   * @param toolFilter Filter deciding which tools the toolset exposes.
   * @param prefix Prepended to the name of every tool the toolset returns,
   *     separated by an underscore. Corresponds to `tool_name_prefix` in
   *     adk-python.
   */
  constructor(
    readonly toolFilter: ToolPredicate | string[],
    readonly prefix?: string,
  ) {}

  /**
   * Returns the tools that should be exposed to LLM.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools.
   */
  abstract getTools(context?: ReadonlyContext): Promise<BaseTool[]>;

  /**
   * Returns the tools of this toolset with `prefix` applied to their names.
   *
   * This is the method the framework calls to build the tool list shown to the
   * model. Subclasses implement `getTools()` and must not override this
   * method; it is the equivalent of the `@final` decorator adk-python puts on
   * `get_tools_with_prefix()`.
   *
   * The result is cached for the invocation that `context` belongs to, so a
   * toolset is listed once per invocation rather than once per LLM request.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools. Without a prefix
   *     these are the tools `getTools()` returned; with one they are copies
   *     whose name and function declaration carry the prefix.
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
    this.cachedTools = prefix
      ? tools.map((tool) => withPrefixedName(tool, `${prefix}_${tool.name}`))
      : tools;
    this.cachedInvocationId = invocationId;
    return this.cachedTools;
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
  abstract close(): Promise<void>;

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
   * @param _toolContext The context of the tool.
   * @param _llmRequest The outgoing LLM request, mutable this method.
   */
  async processLlmRequest(
    _toolContext: Context,
    _llmRequest: LlmRequest,
  ): Promise<void> {}
}
