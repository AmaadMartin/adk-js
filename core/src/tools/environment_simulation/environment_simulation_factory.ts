/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SingleBeforeToolCallback} from '../../agents/llm_agent.js';

import {EnvironmentSimulationConfig} from './environment_simulation_config.js';
import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
import {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';

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
   * Creates a simulation callback to set as an agent's `beforeToolCallback`.
   *
   * @param config The simulation to run.
   * @returns A callback that answers a tool call, or returns `undefined` to
   *     run the real tool.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  static createCallback(
    config: EnvironmentSimulationConfig,
  ): SingleBeforeToolCallback {
    const simulatorEngine = new EnvironmentSimulationEngine(config);
    return ({tool, args, context}) =>
      simulatorEngine.simulate(tool, args, context);
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
