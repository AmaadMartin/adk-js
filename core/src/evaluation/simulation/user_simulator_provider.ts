/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
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
 * Message of the error thrown for an eval case that carries both kinds of
 * conversation data. Matches adk-python's wording.
 */
const BOTH_CONVERSATION_DATA_ERROR =
  'Both static invocations and conversation scenario provided in ' +
  'EvalCase. Provide exactly one.';

/** Builds the error for a config no simulator answers to. */
function unregisteredConfigTypeError(configType: string): string {
  const registered = registeredUserSimulatorTypes();
  return (
    `No UserSimulator registered for config type \`${configType}\`. ` +
    'Register one via `registerUserSimulator()`. Currently registered: ' +
    `${registered.length > 0 ? registered.join(', ') : 'none'}.`
  );
}

/**
 * Supplies the simulator that plays the user for one eval case.
 *
 * A case carrying a static `conversation` replays its pre-authored turns,
 * whatever the config says. A case carrying a `conversationScenario` is routed
 * on the config's `type` discriminator to whichever simulator registered for
 * it, so a new simulator becomes reachable through
 * {@link registerUserSimulator} without this class changing.
 */
export class UserSimulatorProvider {
  private readonly config: BaseUserSimulatorConfig;

  /**
   * @param userSimulatorConfig The simulator config, as it arrives from
   *     `EvalConfig.userSimulatorConfig`. Declared `unknown` because that
   *     field holds whatever the eval config JSON carried. Omitting it stores
   *     a bare base config, which dispatches to no simulator.
   * @throws {InputValidationError} If the value is not a valid base config.
   */
  constructor(userSimulatorConfig: unknown = {}) {
    this.config = parseBaseUserSimulatorConfig(userSimulatorConfig);
  }

  /**
   * Returns a fresh simulator for `evalCase`.
   *
   * @param evalCase The case the simulator drives. It must carry exactly one
   *     of `conversation` and `conversationScenario`.
   * @returns A simulator, never shared with another case or another run.
   * @throws {InputValidationError} If the case carries neither kind of
   *     conversation data or both, or if no simulator is registered for the
   *     config's `type`.
   */
  provide(evalCase: EvalCase): UserSimulator {
    if (evalCase.conversation !== undefined) {
      if (evalCase.conversationScenario !== undefined) {
        throw new InputValidationError(BOTH_CONVERSATION_DATA_ERROR);
      }
      return new StaticUserSimulator(evalCase.conversation);
    }

    if (evalCase.conversationScenario === undefined) {
      throw new InputValidationError(NO_CONVERSATION_DATA_ERROR);
    }

    const configType = this.config.type ?? BASE_USER_SIMULATOR_CONFIG_NAME;
    const factory = getRegisteredUserSimulator(configType);
    if (factory === undefined) {
      throw new InputValidationError(unregisteredConfigTypeError(configType));
    }
    return factory({
      config: this.config,
      conversationScenario: evalCase.conversationScenario,
    });
  }
}
