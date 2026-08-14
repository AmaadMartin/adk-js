/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BasePlugin, BaseTool, SingleAgentCallback} from '@google/adk';

/**
 * The registry holds any tool, not only function tools.
 *
 * Bare `FunctionTool` means `FunctionTool<undefined>` — a tool that takes no
 * arguments — so it cannot hold the schema-carrying tools this registry is
 * given.
 */
export class IntegrationRegistry {
  private tools = new Map<string, BaseTool>();
  private beforeAgentCallbacks = new Map<string, SingleAgentCallback>();
  private afterAgentCallbacks = new Map<string, SingleAgentCallback>();
  private plugins = new Map<string, BasePlugin>();

  summary(): string {
    return (
      `${this.tools.size} tools, ` +
      `${this.beforeAgentCallbacks.size} before agent callbacks, ` +
      `${this.afterAgentCallbacks.size} after agent callbacks, ` +
      `and ${this.plugins.size} plugins.`
    );
  }

  registerTool(name: string, tool: BaseTool) {
    this.tools.set(name, tool);
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  registerBeforeAgentCallback(name: string, callback: SingleAgentCallback) {
    this.beforeAgentCallbacks.set(name, callback);
  }

  getBeforeAgentCallback(name: string): SingleAgentCallback | undefined {
    return this.beforeAgentCallbacks.get(name);
  }

  registerAfterAgentCallback(name: string, callback: SingleAgentCallback) {
    this.afterAgentCallbacks.set(name, callback);
  }

  getAfterAgentCallback(name: string): SingleAgentCallback | undefined {
    return this.afterAgentCallbacks.get(name);
  }

  registerPlugin(name: string, plugin: BasePlugin) {
    this.plugins.set(name, plugin);
  }

  getPlugin(name: string): BasePlugin | undefined {
    return this.plugins.get(name);
  }
}
