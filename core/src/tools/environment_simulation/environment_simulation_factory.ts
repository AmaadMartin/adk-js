/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {BaseTool} from '../base_tool.js';

import {EnvironmentSimulationConfig} from './environment_simulation_config.js';
import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
import {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';

/**
 * Answers a tool call from a simulated environment, or `undefined` to run the
 * real tool.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export type EnvironmentSimulationCallback = (
  tool: BaseTool,
  args: Record<string, unknown>,
  toolContext: Context,
) => Promise<Record<string, unknown> | undefined>;

/**
 * Builds the two ways to run an agent against a simulated environment.
 *
 * Each method builds its own engine, so two simulators never share a state
 * store. Both throw when the experimental `ENVIRONMENT_SIMULATION` feature is
 * off, because the engine constructor they call first checks it.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class EnvironmentSimulationFactory {
  /**
   * Creates a simulation callback for callers who wire callbacks on an agent.
   *
   * @param config The simulation to run.
   * @returns A function shaped like a `beforeToolCallback`.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  static createCallback(
    config: EnvironmentSimulationConfig,
  ): EnvironmentSimulationCallback {
    const simulatorEngine = new EnvironmentSimulationEngine(config);
    return (tool, args, toolContext) =>
      simulatorEngine.simulate(tool, args, toolContext);
  }

  /**
   * Creates a plugin to register on a `Runner`.
   *
   * @param config The simulation to run.
   * @returns A plugin that simulates the configured tools.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  static createPlugin(
    config: EnvironmentSimulationConfig,
  ): EnvironmentSimulationPlugin {
    return new EnvironmentSimulationPlugin(
      new EnvironmentSimulationEngine(config),
    );
  }
}
