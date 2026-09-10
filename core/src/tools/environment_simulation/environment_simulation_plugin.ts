/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {BasePlugin} from '../../plugins/base_plugin.js';
import {BaseTool} from '../base_tool.js';

import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';

/** The name every instance of this plugin reports, as in adk-python. */
const PLUGIN_NAME = 'EnvironmentSimulation';

/**
 * Answers a tool call from an {@link EnvironmentSimulationEngine}.
 *
 * Register it on a `Runner` to run an agent against simulated tools. Build it
 * with `EnvironmentSimulationFactory.createPlugin` rather than directly.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class EnvironmentSimulationPlugin extends BasePlugin {
  /**
   * @param simulatorEngine The engine that produces the simulated responses.
   */
  constructor(private readonly simulatorEngine: EnvironmentSimulationEngine) {
    super(PLUGIN_NAME);
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.simulatorEngine.simulate(
      params.tool,
      params.toolArgs,
      params.toolContext,
    );
  }
}
