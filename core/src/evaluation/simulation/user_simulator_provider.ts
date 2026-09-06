/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
import {EvalCase} from '../eval_case.js';
import {StaticUserSimulator} from './static_user_simulator.js';
import {UserSimulator} from './user_simulator.js';

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
 * Every eval case adk-js can express today carries a static conversation, so
 * every case replays its own pre-authored turns. adk-python also routes a case
 * that describes a goal to a model-backed simulator, but adk-js has no
 * `conversationScenario` on `EvalCase` and no such simulator, so that case is
 * rejected rather than guessed at.
 */
export class UserSimulatorProvider {
  /**
   * Returns a fresh simulator for `evalCase`.
   *
   * @param evalCase The case the simulator drives.
   * @returns A simulator, never shared with another case or another run.
   * @throws {InputValidationError} If the case carries no static conversation.
   */
  provide(evalCase: EvalCase): UserSimulator {
    if (evalCase.conversation === undefined) {
      throw new InputValidationError(NO_CONVERSATION_DATA_ERROR);
    }
    return new StaticUserSimulator(evalCase.conversation);
  }
}
