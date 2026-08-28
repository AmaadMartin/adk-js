/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SingleBeforeToolCallback} from '../../agents/llm_agent.js';
import {experimental} from '../../utils/experimental.js';

import {EnvironmentSimulationConfig} from './environment_simulation_config.js';
import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
import {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';

/**
 * Builds the two ways of attaching an environment simulation to a run.
 *
 * Each factory call builds one engine, and everything it returns shares that
 * engine. The shared engine is what makes stateful mocking work: it keeps the
 * connection map and the entities the tools have minted.
 *
 * @experimental
 */
@experimental
export class EnvironmentSimulationFactory {
  /**
   * Builds a callback for a single agent's `beforeToolCallback`.
   *
   * @param config The environment to simulate.
   * @return A callback that answers the configured tools from the simulation.
   * @experimental
   */
  @experimental
  static createCallback(
    config: EnvironmentSimulationConfig,
  ): SingleBeforeToolCallback {
    const engine = new EnvironmentSimulationEngine(config);
    return ({tool, args, context}) => engine.simulate(tool, args, context);
  }

  /**
   * Builds a plugin that simulates the configured tools for every agent a
   * runner drives.
   *
   * @param config The environment to simulate.
   * @return The plugin to register on a runner.
   * @experimental
   */
  @experimental
  static createPlugin(
    config: EnvironmentSimulationConfig,
  ): EnvironmentSimulationPlugin {
    return new EnvironmentSimulationPlugin(
      new EnvironmentSimulationEngine(config),
    );
  }
}
