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
 * Runs an {@link EnvironmentSimulationEngine} in front of every tool call of
 * every agent in a runner. Configured tools return a simulated response and
 * never execute; unconfigured tools are untouched.
 */
@experimental
export class EnvironmentSimulationPlugin extends BasePlugin {
  /**
   * @param simulatorEngine The engine deciding how each tool call is handled.
   */
  constructor(private readonly simulatorEngine: EnvironmentSimulationEngine) {
    super('EnvironmentSimulation');
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
    return this.simulatorEngine.simulate({tool, args: toolArgs, toolContext});
  }
}
