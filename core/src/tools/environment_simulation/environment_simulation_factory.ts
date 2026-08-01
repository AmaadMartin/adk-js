/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SingleBeforeToolCallback} from '../../agents/llm_agent.js';
import {experimental} from '../../utils/experimental.js';

import {EnvironmentSimulationConfigInput} from './environment_simulation_config.js';
import {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
import {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';

/** Builds the two supported ways of installing an environment simulation. */
export class EnvironmentSimulationFactory {
  /**
   * Creates a before-tool callback simulating one agent's tool calls.
   *
   * @param config The simulation configuration.
   * @returns A callback to pass as an `LlmAgent`'s `beforeToolCallback`.
   */
  @experimental
  static createCallback(
    config: EnvironmentSimulationConfigInput,
  ): SingleBeforeToolCallback {
    const simulatorEngine = new EnvironmentSimulationEngine(config);
    return ({tool, args, context}) =>
      simulatorEngine.simulate({tool, args, toolContext: context});
  }

  /**
   * Creates a plugin simulating the tool calls of every agent in a runner.
   *
   * @param config The simulation configuration.
   * @returns A plugin to pass in a `Runner`'s `plugins`.
   */
  @experimental
  static createPlugin(
    config: EnvironmentSimulationConfigInput,
  ): EnvironmentSimulationPlugin {
    return new EnvironmentSimulationPlugin(
      new EnvironmentSimulationEngine(config),
    );
  }
}
