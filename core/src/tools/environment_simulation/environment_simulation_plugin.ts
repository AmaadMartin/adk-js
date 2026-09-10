/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {BasePlugin} from '../../plugins/base_plugin.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';

import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';

/**
 * Serves every agent's tool calls from a simulated environment.
 *
 * A plugin applies to every agent the runner executes. Use
 * `EnvironmentSimulationFactory.createCallback` instead to simulate the tools
 * of one agent.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class EnvironmentSimulationPlugin extends BasePlugin {
  private readonly simulatorEngine: EnvironmentSimulationEngine;

  /**
   * @param simulatorEngine The engine that answers the intercepted calls.
   */
  constructor(simulatorEngine: EnvironmentSimulationEngine) {
    super('EnvironmentSimulation');
    this.simulatorEngine = simulatorEngine;
  }

  /**
   * Asks the engine to answer the tool call.
   *
   * @param params.tool The tool the agent is about to call.
   * @param params.toolArgs The arguments it would be called with.
   * @param params.toolContext The context of the call.
   * @returns The simulated response, or undefined to let the real tool run.
   */
  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.simulatorEngine.simulate({
      tool: params.tool,
      args: params.toolArgs,
      toolContext: params.toolContext,
    });
  }
}
