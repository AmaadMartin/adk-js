/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
import type {ConversationScenario} from '../conversation_scenarios.js';
import {EvalCase} from '../eval_case.js';
import {StaticUserSimulator} from './static_user_simulator.js';
import {
  BASE_USER_SIMULATOR_CONFIG_NAME,
  BaseUserSimulatorConfig,
  getRegisteredUserSimulator,
  parseBaseUserSimulatorConfig,
  registeredUserSimulatorTypes,
  UserSimulator,
} from './user_simulator.js';

/**
 * Message of the error thrown for an eval case that carries no conversation
 * data the provider can drive. Matches adk-python's wording.
 */
const NO_CONVERSATION_DATA_ERROR =
  'Neither static invocations nor conversation scenario provided in ' +
  'EvalCase. Provide exactly one.';

/**
 * Message of the error thrown for an eval case that carries both a static
 * conversation and a scenario. Matches adk-python's wording.
 */
const BOTH_CONVERSATION_DATA_ERROR =
  'Both static invocations and conversation scenario provided in ' +
  'EvalCase. Provide exactly one.';

/** Reports that no simulator answers to `configType`, and what does. */
function unregisteredConfigTypeError(configType: string): string {
  return (
    `No UserSimulator registered for config type \`${configType}\`. ` +
    'Register one via `registerUserSimulator()`. Currently registered: ' +
    `[${registeredUserSimulatorTypes().join(', ')}].`
  );
}

/**
 * Supplies the simulator that plays the user for one eval case.
 *
 * A case that carries a static conversation replays its own pre-authored
 * turns, whatever the config says. A case that describes a scenario instead is
 * dispatched on the config's `type` discriminator, so the simulator registered
 * for that type drives it. adk-js registers no simulator of its own yet, so a
 * scenario case is rejected until the caller registers one through
 * `registerUserSimulator`.
 */
export class UserSimulatorProvider {
  private readonly config: BaseUserSimulatorConfig;

  /**
   * @param config The config that selects the scenario simulator. It is
   *   declared `unknown` and validated here because it usually arrives from a
   *   JSON eval config document. Omitting it stores a bare base config, which
   *   dispatches to nothing.
   * @throws {InputValidationError} If `config` is not a config object.
   */
  constructor(config?: unknown) {
    this.config =
      config === undefined ? {} : parseBaseUserSimulatorConfig(config);
  }

  /**
   * Returns a fresh simulator for `evalCase`.
   *
   * @param evalCase The case the simulator drives. It carries exactly one of
   *   `conversation` and `conversationScenario`.
   * @returns A simulator, never shared with another case or another run.
   * @throws {InputValidationError} If the case carries neither or both, or if
   *   no simulator is registered for the config's type.
   */
  provide(evalCase: EvalCase): UserSimulator {
    const {conversation, conversationScenario} = evalCase;
    if (conversation === undefined) {
      if (conversationScenario === undefined) {
        throw new InputValidationError(NO_CONVERSATION_DATA_ERROR);
      }
      return this.provideForScenario(conversationScenario);
    }
    if (conversationScenario !== undefined) {
      throw new InputValidationError(BOTH_CONVERSATION_DATA_ERROR);
    }
    return new StaticUserSimulator(conversation);
  }

  /** Builds the simulator the config's `type` selects. */
  private provideForScenario(
    conversationScenario: ConversationScenario,
  ): UserSimulator {
    const configType = this.config.type ?? BASE_USER_SIMULATOR_CONFIG_NAME;
    const factory = getRegisteredUserSimulator(configType);
    if (factory === undefined) {
      throw new InputValidationError(unregisteredConfigTypeError(configType));
    }
    return factory({config: this.config, conversationScenario});
  }
}
