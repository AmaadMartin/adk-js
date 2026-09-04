/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {resolvesWithin} from '../utils/promise_utils.js';
import type {BaseNode} from '../workflow/base_node.js';
import type {NodeContext} from '../workflow/node_context.js';

import {BasePlugin, ContextCompactionTrigger} from './base_plugin.js';

/**
 * How long each plugin gets to finish its `close()`, in seconds, when the
 * manager is constructed without an explicit timeout.
 *
 * Matches `google/adk-python` `PluginManager.__init__`, whose `close_timeout`
 * defaults to `5.0`.
 */
export const DEFAULT_PLUGIN_CLOSE_TIMEOUT_SECONDS = 5;

/**
 * Manages the registration and execution of plugins.
 *
 * The PluginManager is an internal class that orchestrates the invocation of
 * plugin callbacks at key points in the SDK's execution lifecycle. It maintains
 * a list of registered plugins and ensures they are called in the order they
 * were registered.
 *
 * The core execution logic implements an "early exit" strategy: if any plugin
 * callback returns a non-`undefined` value, the execution of subsequent plugins
 * for that specific event is halted, and the returned value is propagated up
 * the call stack. This allows plugins to short-circuit operations like agent
 * runs, tool calls, or model requests.
 */
export class PluginManager {
  private readonly plugins: Set<BasePlugin> = new Set();
  private skipClosingPlugins = false;

  /** Whether any plugin is registered. */
  get hasPlugins(): boolean {
    return this.plugins.size > 0;
  }

  /**
   * Initializes the plugin service.
   *
   * @param plugins An optional list of plugins to register upon
   *     initialization.
   * @param closeTimeoutSeconds How long each plugin gets to finish its
   *     `close()`, in seconds. A value of zero or less waits indefinitely.
   */
  constructor(
    plugins?: BasePlugin[],
    private readonly closeTimeoutSeconds = DEFAULT_PLUGIN_CLOSE_TIMEOUT_SECONDS,
  ) {
    if (plugins) {
      for (const plugin of plugins) {
        this.registerPlugin(plugin);
      }
    }
  }

  /**
   * Controls whether `close()` tears down the registered plugins.
   *
   * Set this to `true` when another component owns the plugins, for example a
   * parent `Runner` whose plugin list this manager borrowed. `close()` then
   * does nothing, so the shared plugins survive for their owner. The switch is
   * reversible: passing `false` restores normal closing.
   *
   * @param value `true` to skip closing the plugins, `false` to close them.
   */
  setSkipClosingPlugins(value: boolean): void {
    this.skipClosingPlugins = value;
  }

  /**
   * Closes every registered plugin, in registration order.
   *
   * A plugin that throws or exceeds `closeTimeoutSeconds` does not stop the
   * remaining plugins from closing. Closing is sequential rather than
   * concurrent because a plugin that owns a transport, an MCP session for
   * example, must not be torn down while its peers are still using it.
   *
   * Does nothing when `setSkipClosingPlugins(true)` was called. The skip is
   * checked before the first plugin, so no close timeout ever starts.
   *
   * @throws An `AggregateError` naming every plugin that failed to close, once
   *     all of them have been attempted.
   */
  async close(): Promise<void> {
    if (this.skipClosingPlugins) {
      logger.debug(
        'Skipping plugin close; plugins are owned by another component.',
      );
      return;
    }
    const failures: Array<{name: string; error: Error}> = [];
    for (const plugin of this.plugins) {
      const error = await closePlugin(plugin, this.closeTimeoutSeconds);
      if (error) {
        failures.push({name: plugin.name, error});
      }
    }
    if (failures.length > 0) {
      const reasons = failures
        .map((f) => `'${f.name}': ${f.error.message}`)
        .join(', ');
      throw new AggregateError(
        failures.map((f) => f.error),
        `Failed to close plugins: ${reasons}`,
      );
    }
  }

  /**
   * Registers a new plugin.
   *
   * @param plugin The plugin instance to register.
   * @throws If the same exact plugin or a plugin with the same name is already
   *     registered.
   */
  registerPlugin(plugin: BasePlugin): void {
    // Short circuit for duplicate objects or duplicate names
    if (this.plugins.has(plugin)) {
      throw new Error(`Plugin '${plugin.name}' already registered.`);
    }
    if (Array.from(this.plugins).some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin with name '${plugin.name}' already registered.`);
    }

    this.plugins.add(plugin);

    logger.info(`Plugin '${plugin.name}' registered.`);
  }

  /**
   * Retrieves a registered plugin by its name.
   *
   * @param pluginName The name of the plugin to retrieve.
   * @returns The plugin instance if found, otherwise `undefined`.
   */
  getPlugin(pluginName: string): BasePlugin | undefined {
    // Set operates on strict equality, we only want to match by name
    return Array.from(this.plugins).find((p) => p.name === pluginName);
  }

  /**
   * The registered plugins, in registration order.
   *
   * Lets a caller hand this manager's plugins to another runner — an
   * `AgentTool` lends them to the runner it builds for the wrapped agent.
   */
  listPlugins(): BasePlugin[] {
    return Array.from(this.plugins);
  }

  /**
   * Runs the same callback for all plugins. This is a utility method to reduce
   * duplication below.
   *
   * @param plugins The set of plugins to run
   * @param callback A closure containing the callback method to run on each
   *     plugin
   * @param callbackName The name of the function being called in the closure
   *     above. Used for logging purposes.
   * @returns A promise containing the plugin method result. Must be casted to
   *     the proper type for the plugin method.
   */
  private async runCallbacks(
    plugins: Set<BasePlugin>,
    callback: (plugin: BasePlugin) => Promise<unknown>,
    callbackName: string,
  ): Promise<unknown> {
    for (const plugin of plugins) {
      try {
        const result = await callback(plugin);
        if (result !== undefined) {
          logger.debug(
            `Plugin '${plugin.name}' returned a value for callback '${callbackName}', exiting early.`,
          );
          return result;
        }
      } catch (e: unknown) {
        const errorMessage = `Error in plugin '${plugin.name}' during '${callbackName}' callback: ${e}`;
        logger.error(errorMessage);
        throw new Error(errorMessage, {cause: e});
      }
    }
    return undefined;
  }

  /**
   * Runs the `onUserMessageCallback` for all plugins.
   */
  async runOnUserMessageCallback({
    userMessage,
    invocationContext,
  }: {
    userMessage: Content;
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onUserMessageCallback({userMessage, invocationContext}),
      'onUserMessageCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `beforeRunCallback` for all plugins.
   */
  async runBeforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) => plugin.beforeRunCallback({invocationContext}),
      'beforeRunCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `afterRunCallback` for all plugins.
   */
  async runAfterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) => plugin.afterRunCallback({invocationContext}),
      'afterRunCallback',
    );
  }

  /**
   * Runs the `onEventCallback` for all plugins.
   */
  async runOnEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onEventCallback({invocationContext, event}),
      'onEventCallback',
    )) as Event | undefined;
  }

  /**
   * Runs the `beforeAgentCallback` for all plugins.
   */
  async runBeforeAgentCallback({
    agent,
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeAgentCallback({agent, callbackContext}),
      'beforeAgentCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `afterAgentCallback` for all plugins.
   */
  async runAfterAgentCallback({
    agent,
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterAgentCallback({agent, callbackContext}),
      'afterAgentCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `beforeNodeCallback` for all plugins.
   */
  async runBeforeNodeCallback({
    node,
    nodeContext,
    input,
  }: {
    node: BaseNode;
    nodeContext: NodeContext;
    input: unknown;
  }): Promise<unknown> {
    return this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeNodeCallback({node, nodeContext, input}),
      'beforeNodeCallback',
    );
  }

  /**
   * Runs the `afterNodeCallback` for all plugins.
   */
  async runAfterNodeCallback({
    node,
    nodeContext,
    output,
  }: {
    node: BaseNode;
    nodeContext: NodeContext;
    output: unknown;
  }): Promise<unknown> {
    return this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterNodeCallback({node, nodeContext, output}),
      'afterNodeCallback',
    );
  }

  /**
   * Runs the `beforeToolSelection` for all plugins.
   */
  async runBeforeToolSelection({
    callbackContext,
    tools,
  }: {
    callbackContext: Context;
    tools: Readonly<Record<string, BaseTool>>;
  }): Promise<Readonly<Record<string, BaseTool>> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeToolSelection({callbackContext, tools}),
      'beforeToolSelection',
    )) as Readonly<Record<string, BaseTool>> | undefined;
  }

  /**
   * Runs the `beforeContextCompaction` for all plugins.
   */
  async runBeforeContextCompaction({
    invocationContext,
    trigger,
  }: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeContextCompaction({invocationContext, trigger}),
      'beforeContextCompaction',
    );
  }

  /**
   * Runs the `afterContextCompaction` for all plugins.
   */
  async runAfterContextCompaction({
    invocationContext,
    trigger,
  }: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterContextCompaction({invocationContext, trigger}),
      'afterContextCompaction',
    );
  }

  /**
   * Runs the `beforeToolCallback` for all plugins.
   */
  async runBeforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeToolCallback({tool, toolArgs, toolContext}),
      'beforeToolCallback',
    )) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the `afterToolCallback` for all plugins.
   */
  async runAfterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterToolCallback({tool, toolArgs, toolContext, result}),
      'afterToolCallback',
    )) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the `onModelErrorCallback` for all plugins.
   */
  async runOnModelErrorCallback({
    callbackContext,
    llmRequest,
    error,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onModelErrorCallback({callbackContext, llmRequest, error}),
      'onModelErrorCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `beforeModelCallback` for all plugins.
   */
  async runBeforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeModelCallback({callbackContext, llmRequest}),
      'beforeModelCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `afterModelCallback` for all plugins.
   */
  async runAfterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterModelCallback({callbackContext, llmResponse}),
      'afterModelCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `onToolErrorCallback` for all plugins.
   */
  async runOnToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onToolErrorCallback({tool, toolArgs, toolContext, error}),
      'onToolErrorCallback',
    )) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the `onAgentErrorCallback` for all plugins.
   */
  async runOnAgentErrorCallback({
    agent,
    callbackContext,
    error,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
    error: Error;
  }): Promise<void> {
    await this.runNotificationCallbacks(
      (plugin: BasePlugin) =>
        plugin.onAgentErrorCallback({agent, callbackContext, error}),
      'onAgentErrorCallback',
    );
  }

  /**
   * Runs the `onRunErrorCallback` for all plugins.
   */
  async runOnRunErrorCallback({
    invocationContext,
    error,
  }: {
    invocationContext: InvocationContext;
    error: Error;
  }): Promise<void> {
    await this.runNotificationCallbacks(
      (plugin: BasePlugin) =>
        plugin.onRunErrorCallback({invocationContext, error}),
      'onRunErrorCallback',
    );
  }

  /**
   * Runs a notification-only callback for every registered plugin.
   *
   * Unlike {@link runCallbacks} this method never exits early and never
   * re-throws: a plugin that fails is logged and the next one still runs. A
   * notification reports an error that already happened, so a failure here must
   * not replace the error the caller is about to propagate.
   *
   * @param callback A closure containing the callback method to run on each
   *     plugin.
   * @param callbackName The name of the callback, used for logging.
   */
  private async runNotificationCallbacks(
    callback: (plugin: BasePlugin) => Promise<void>,
    callbackName: string,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await callback(plugin);
      } catch (e: unknown) {
        logger.error(
          `Error in plugin '${plugin.name}' during '${callbackName}' callback: ${formatError(e)}`,
        );
      }
    }
  }
}

/**
 * Closes one plugin, giving it `timeoutSeconds` to finish.
 *
 * @param plugin The plugin to close.
 * @param timeoutSeconds How long to wait, in seconds. Zero or less waits
 *     indefinitely.
 * @returns The reason the plugin failed to close, or `undefined` when it
 *     closed cleanly.
 */
async function closePlugin(
  plugin: BasePlugin,
  timeoutSeconds: number,
): Promise<Error | undefined> {
  try {
    if (await resolvesWithin(plugin.close(), timeoutSeconds)) {
      return undefined;
    }
    logger.warn(`Timed out closing plugin '${plugin.name}'.`);
    return new Error(
      `Closing plugin '${plugin.name}' timed out after ${timeoutSeconds}s.`,
    );
  } catch (e: unknown) {
    logger.error(`Error closing plugin '${plugin.name}'.`, e);
    return new Error(formatError(e), {cause: e});
  }
}
