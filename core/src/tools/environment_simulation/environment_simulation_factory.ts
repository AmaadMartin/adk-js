/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SingleBeforeToolCallback} from '../../agents/llm_agent.js';
import {
  assertFeatureEnabled,
  FeatureName,
} from '../../features/feature_registry.js';

import {EnvironmentSimulationConfig} from './environment_simulation_config.js';
import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
import {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';

/**
 * Turns an {@link EnvironmentSimulationConfig} into something an agent runs.
 *
 * Each call builds one {@link EnvironmentSimulationEngine} and hands it to the
 * callback or the plugin it returns. The engine outlives the individual tool
 * call, so the entities one simulated call creates are there for the next one
 * to read.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class EnvironmentSimulationFactory {
  /**
   * Creates a `beforeToolCallback` that simulates one agent's tools.
   *
   * @param config The environment to simulate.
   * @returns A callback to pass as an agent's `beforeToolCallback`. Reuse it:
   *     every call it answers shares one engine.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  static createCallback(
    config: EnvironmentSimulationConfig,
  ): SingleBeforeToolCallback {
    assertFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION);
    const simulatorEngine = new EnvironmentSimulationEngine(config);
    return ({tool, args, context}) =>
      simulatorEngine.simulate({tool, args, toolContext: context});
  }

  /**
   * Creates a plugin that simulates the tools of every agent in a run.
   *
   * @param config The environment to simulate.
   * @returns A plugin to pass to the runner.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  static createPlugin(
    config: EnvironmentSimulationConfig,
  ): EnvironmentSimulationPlugin {
    assertFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION);
    return new EnvironmentSimulationPlugin(
      new EnvironmentSimulationEngine(config),
    );
  }
}
