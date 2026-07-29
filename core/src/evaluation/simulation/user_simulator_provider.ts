/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {EvalCase} from '../eval_case.js';

import {StaticUserSimulator} from './static_user_simulator.js';
import {UserSimulator} from './user_simulator.js';

/**
 * Provides a {@link UserSimulator} instance for an {@link EvalCase}.
 *
 * simplicity: static-conversation only. Scenario-driven (LLM-backed) user
 * simulation is part of the deferred live/scenario eval work and is not yet
 * ported to adk-js; an eval case that carries a `conversationScenario` instead
 * of a static `conversation` is rejected here. Upgrade path: register
 * scenario-backed simulators once that sub-port lands.
 */
@experimental
export class UserSimulatorProvider {
  /**
   * Returns a {@link UserSimulator} for the given eval case.
   *
   * @param evalCase An eval case that carries a static `conversation`.
   * @returns A {@link StaticUserSimulator} that replays the static conversation.
   * @throws {Error} If the eval case has no static `conversation` (e.g. it uses
   *     a `conversationScenario`), which is not supported by this port.
   */
  provide(evalCase: EvalCase): UserSimulator {
    if (evalCase.conversation !== undefined) {
      return new StaticUserSimulator(evalCase.conversation);
    }

    throw new Error(
      'UserSimulatorProvider only supports eval cases with a static' +
        ' `conversation`; scenario-driven (LLM-backed) user simulation is not' +
        ' yet supported in adk-js.',
    );
  }
}
