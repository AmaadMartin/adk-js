/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {BasePlugin} from '../../plugins/base_plugin.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';

const PLUGIN_NAME = 'EnvironmentSimulation';

/**
 * Produces a simulated response for a tool call.
 *
 * A simulator decides, per call, whether the agent gets a canned result or the
 * real tool runs.
 */
export interface ToolCallSimulator {
  /**
   * Simulates one tool call.
   *
   * @param tool The tool the agent is about to call.
   * @param args The arguments the agent passed to the tool.
   * @param toolContext The context of the tool call.
   * @returns The simulated tool result, or `undefined` to run the real tool.
   */
  simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<Record<string, unknown> | undefined>;
}

/**
 * Routes every tool call through a simulator instead of the real tool.
 *
 * The simulator answers with a result, which becomes the tool's result, or
 * with `undefined`, which lets the real tool run. A rejection from the
 * simulator propagates: a failed simulation must not silently call the real
 * tool.
 *
 * Example:
 * ```typescript
 * const runner = new Runner({
 *   appName: 'demo',
 *   agent: rootAgent,
 *   sessionService,
 *   plugins: [new EnvironmentSimulationPlugin(simulator)],
 * });
 * ```
 */
@experimental
export class EnvironmentSimulationPlugin extends BasePlugin {
  private readonly simulator: ToolCallSimulator;

  /**
   * @param simulator The simulator every tool call is routed through.
   * @throws If the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  constructor(simulator: ToolCallSimulator) {
    super(PLUGIN_NAME);
    if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
      throw new Error(
        `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
      );
    }
    this.simulator = simulator;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.simulator.simulate(tool, toolArgs, toolContext);
  }
}
