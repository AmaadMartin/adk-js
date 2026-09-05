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
 * Builds the two ways to attach an environment simulation to an agent run.
 *
 * Both build one {@link EnvironmentSimulationEngine} and share it, so the
 * entities the simulation creates stay visible across the whole run.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class EnvironmentSimulationFactory {
  /**
   * Builds a before-tool callback that simulates one agent's tools.
   *
   * @param config The simulation to run.
   * @returns A callback for `LlmAgent`'s `beforeToolCallback`.
   */
  static createCallback(
    config: EnvironmentSimulationConfig,
  ): SingleBeforeToolCallback {
    const simulationEngine = new EnvironmentSimulationEngine(config);
    return (params) => simulationEngine.simulate(params);
  }

  /**
   * Builds a plugin that simulates the tools of a whole run.
   *
   * @param config The simulation to run.
   * @returns A plugin for the runner's `plugins`.
   */
  static createPlugin(
    config: EnvironmentSimulationConfig,
  ): EnvironmentSimulationPlugin {
    return new EnvironmentSimulationPlugin(
      new EnvironmentSimulationEngine(config),
    );
  }
}
