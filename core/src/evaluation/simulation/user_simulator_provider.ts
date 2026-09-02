/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
import {NotFoundError} from '../../errors/not_found_error.js';
import {EvalCase} from '../eval_case.js';
import {StaticUserSimulator} from './static_user_simulator.js';
import {
  BaseUserSimulatorConfig,
  UserSimulator,
  userSimulatorRegistry,
} from './user_simulator.js';

/**
 * Message of the error thrown for an eval case that carries no conversation
 * data the provider can drive. Matches adk-python's wording.
 */
const NO_CONVERSATION_DATA_ERROR =
  'Neither static invocations nor conversation scenario provided in ' +
  'EvalCase. Provide exactly one.';

/**
 * Supplies the simulator that plays the user for one eval case.
 *
 * An eval case that carries a static conversation replays it, whatever the
 * config says. Every other case is routed by `type` to the simulator
 * registered for it, so a new simulator needs no change here.
 */
export class UserSimulatorProvider {
  private readonly userSimulatorConfig?: BaseUserSimulatorConfig;

  /**
   * @param options.userSimulatorConfig Selects the simulator for cases without
   *     a static conversation.
   */
  constructor(options: {userSimulatorConfig?: BaseUserSimulatorConfig} = {}) {
    this.userSimulatorConfig = options.userSimulatorConfig;
  }

  /**
   * Returns a fresh simulator for `evalCase`.
   *
   * @param evalCase The case the simulator drives.
   * @returns A simulator, never shared with another case or another run.
   * @throws {InputValidationError} If the case carries no static conversation
   *     and the config names no simulator.
   * @throws {NotFoundError} If the config names a simulator nothing
   *     registered.
   */
  provide(evalCase: EvalCase): UserSimulator {
    if (evalCase.conversation !== undefined) {
      return new StaticUserSimulator(evalCase.conversation);
    }

    const config = this.userSimulatorConfig;
    if (config?.type === undefined) {
      throw new InputValidationError(NO_CONVERSATION_DATA_ERROR);
    }

    const registry = userSimulatorRegistry();
    const factory = registry.get(config.type);
    if (factory === undefined) {
      const registered = [...registry.keys()].sort();
      throw new NotFoundError(
        `No UserSimulator registered for config type \`${config.type}\`. ` +
          'Register one via `registerUserSimulator()`. Currently ' +
          `registered: [${registered.join(', ')}].`,
      );
    }
    return factory({config, evalCase});
  }
}
