/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {ConversationScenario} from '../conversation_scenarios.js';
import {EvalCase} from '../eval_case.js';
import {
  LlmBackedUserSimulator,
  LlmBackedUserSimulatorConfig,
} from './llm_backed_user_simulator.js';
import {StaticUserSimulator} from './static_user_simulator.js';
import {
  BaseUserSimulatorConfig,
  BaseUserSimulatorConfigClass,
  registerUserSimulator,
  SIMULATOR_BY_CONFIG_TYPE,
  UserSimulator,
} from './user_simulator.js';

// Built-in user-simulator registrations. Importing this module wires up ADK's
// built-in simulators to the shared dispatch registry ("batteries included").
// (Audio registration is intentionally absent -- it is a separate port.)
registerUserSimulator(LlmBackedUserSimulatorConfig, LlmBackedUserSimulator);

type ScenarioSimulatorClass = new (args: {
  config: BaseUserSimulatorConfig;
  conversationScenario: ConversationScenario;
}) => UserSimulator;

/**
 * Provides a {@link UserSimulator} per {@link EvalCase}, mixing configuration
 * with per-eval-case conversation data.
 *
 * Dispatch is driven by the runtime type of the config, looked up against the
 * shared {@link SIMULATOR_BY_CONFIG_TYPE} registry.
 */
@experimental
export class UserSimulatorProvider {
  private readonly userSimulatorConfig: BaseUserSimulatorConfig;

  /**
   * Creates a `UserSimulatorProvider`.
   *
   * @param userSimulatorConfig Optional config; when omitted, the legacy
   *     default (`LlmBackedUserSimulatorConfig`) is used.
   * @throws {Error} If a non-`BaseUserSimulatorConfig` value is supplied.
   */
  constructor(userSimulatorConfig?: BaseUserSimulatorConfig | null) {
    if (userSimulatorConfig === undefined || userSimulatorConfig === null) {
      // Historical default: instantiate an LlmBackedUserSimulator.
      this.userSimulatorConfig = new LlmBackedUserSimulatorConfig();
    } else if (!(userSimulatorConfig instanceof BaseUserSimulatorConfig)) {
      throw new Error('Expect config of type `BaseUserSimulatorConfig`.');
    } else {
      this.userSimulatorConfig = userSimulatorConfig;
    }
  }

  /**
   * Provides an appropriate user simulator based on the eval case and config.
   *
   * A static `conversation` yields a {@link StaticUserSimulator}
   * (config-agnostic); otherwise the simulator registered for the config's
   * runtime type is instantiated with the case's scenario.
   *
   * @param evalCase The eval case (carries a conversation xor a scenario).
   * @returns The provided user simulator.
   * @throws {Error} If no simulator is registered for the config type.
   */
  provide(evalCase: EvalCase): UserSimulator {
    if (evalCase.conversation !== undefined) {
      return new StaticUserSimulator({
        staticConversation: evalCase.conversation,
      });
    }

    const configType = this.userSimulatorConfig
      .constructor as BaseUserSimulatorConfigClass;
    const simulatorClass = SIMULATOR_BY_CONFIG_TYPE.get(configType);
    if (simulatorClass === undefined) {
      const registered = [...SIMULATOR_BY_CONFIG_TYPE.keys()]
        .map((configClass) => configClass.name)
        .sort();
      throw new Error(
        `No UserSimulator registered for config type \`${configType.name}\`.` +
          ' Register one via `registerUserSimulator()`. Currently registered:' +
          ` [${registered.join(', ')}].`,
      );
    }

    return new (simulatorClass as unknown as ScenarioSimulatorClass)({
      config: this.userSimulatorConfig,
      conversationScenario:
        evalCase.conversationScenario as ConversationScenario,
    });
  }
}
