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

/** The plugin name every simulation plugin registers under. */
const PLUGIN_NAME = 'environment_simulation';

/**
 * Simulates the configured tools for every agent a runner drives.
 *
 * @experimental
 */
@experimental
export class EnvironmentSimulationPlugin extends BasePlugin {
  private readonly engine: EnvironmentSimulationEngine;

  /**
   * @param engine The engine that decides what a simulated call returns.
   */
  constructor(engine: EnvironmentSimulationEngine) {
    super(PLUGIN_NAME);
    this.engine = engine;
  }

  /**
   * Answers a tool call from the simulation instead of running the tool.
   *
   * @param params.tool The tool the agent called.
   * @param params.toolArgs The arguments the agent called it with.
   * @param params.toolContext The context of the call.
   * @return The simulated response, or `undefined` to let the real tool run.
   */
  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.engine.simulate(
      params.tool,
      params.toolArgs,
      params.toolContext,
    );
  }
}
