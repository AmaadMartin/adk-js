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
 * Runs an environment simulation for every tool call of a runner.
 *
 * Build it with `EnvironmentSimulationFactory.createPlugin`, and pass it to the
 * runner's `plugins`. Use `createCallback` instead to simulate the tools of one
 * agent rather than of the whole run.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class EnvironmentSimulationPlugin extends BasePlugin {
  private readonly simulationEngine: EnvironmentSimulationEngine;

  /**
   * @param simulationEngine The engine that holds the simulation's state.
   */
  constructor(simulationEngine: EnvironmentSimulationEngine) {
    super('EnvironmentSimulation');
    this.simulationEngine = simulationEngine;
  }

  /**
   * Answers the tool call from the simulation, when the tool is simulated.
   *
   * @param params.tool The tool the agent asked to call.
   * @param params.toolArgs The arguments the agent passed.
   * @param params.toolContext The context of the tool call.
   * @returns The simulated response, or `undefined` to let the real tool run.
   */
  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.simulationEngine.simulate({
      tool: params.tool,
      args: params.toolArgs,
      context: params.toolContext,
    });
  }
}
