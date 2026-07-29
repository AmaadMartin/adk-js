/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {ConversationScenario} from '../conversation_scenarios.js';
import {EvalCase} from '../eval_case.js';
import {
  LlmAudioUserSimulator,
  LlmAudioUserSimulatorConfig,
} from './llm_audio_user_simulator.js';
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
registerUserSimulator(LlmBackedUserSimulatorConfig, LlmBackedUserSimulator);
registerUserSimulator(LlmAudioUserSimulatorConfig, LlmAudioUserSimulator);

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
   * Routing:
   * - A static `conversation` yields a {@link StaticUserSimulator}, wrapped in an
   *   {@link LlmAudioUserSimulator} when the config selects the audio decorator.
   * - Otherwise the simulator registered for the config's runtime type is
   *   instantiated with the case's scenario. When that is
   *   {@link LlmAudioUserSimulator}, an inner {@link LlmBackedUserSimulator} is
   *   built from a text config derived from the audio config and injected as the
   *   decorator's text simulator.
   *
   * @param evalCase The eval case (carries a conversation xor a scenario).
   * @returns The provided user simulator.
   * @throws {Error} If no simulator is registered for the config type.
   */
  provide(evalCase: EvalCase): UserSimulator {
    const configType = this.userSimulatorConfig
      .constructor as BaseUserSimulatorConfigClass;
    const simulatorClass = SIMULATOR_BY_CONFIG_TYPE.get(configType);

    if (evalCase.conversation !== undefined) {
      // Static conversations replay pre-authored turns.
      const staticSimulator = new StaticUserSimulator({
        staticConversation: evalCase.conversation,
      });
      // When an audio config is set, route the static turns through the audio
      // decorator so they are synthesized to audio, just like the scenario case.
      // An unregistered config is treated as "no audio" here (rather than
      // throwing as the scenario branch does), preserving the pre-existing
      // behavior of the static path ignoring the config entirely.
      if (simulatorClass === LlmAudioUserSimulator) {
        return new LlmAudioUserSimulator({
          config: this.userSimulatorConfig,
          textSimulator: staticSimulator,
        });
      }
      return staticSimulator;
    }

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

    const conversationScenario =
      evalCase.conversationScenario as ConversationScenario;

    // When the config resolves to the audio decorator, build the inner
    // LlmBackedUserSimulator first and inject it as the text simulator.
    if (simulatorClass === LlmAudioUserSimulator) {
      const audioConfig = this
        .userSimulatorConfig as LlmAudioUserSimulatorConfig;
      const textConfig = new LlmBackedUserSimulatorConfig({
        model: audioConfig.model,
        modelConfiguration: audioConfig.modelConfiguration,
        maxAllowedInvocations: audioConfig.maxAllowedInvocations,
        customInstructions: audioConfig.customInstructions,
        includeFunctionCalls: audioConfig.includeFunctionCalls,
      });
      const textSimulator = new LlmBackedUserSimulator({
        config: textConfig,
        conversationScenario,
      });
      return new LlmAudioUserSimulator({config: audioConfig, textSimulator});
    }

    return new (simulatorClass as unknown as ScenarioSimulatorClass)({
      config: this.userSimulatorConfig,
      conversationScenario,
    });
  }
}
