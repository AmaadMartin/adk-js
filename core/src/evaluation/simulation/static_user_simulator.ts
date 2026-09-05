/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {Invocation} from '../eval_case.js';
import {Evaluator} from '../evaluator.js';
import {
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
} from './user_simulator.js';

/**
 * Replays the pre-authored turns of an eval case's static conversation.
 *
 * The agent's replies do not change what the user says next, so this simulator
 * ignores the conversation history and hands back one scripted turn per call.
 * Running past the end of the script is the normal end of the conversation,
 * not an error.
 */
export class StaticUserSimulator implements UserSimulator {
  private invocationIdx = 0;

  /**
   * @param staticConversation The turns to replay, in order.
   */
  constructor(private readonly staticConversation: Invocation[]) {}

  /**
   * Returns the next scripted turn.
   *
   * @param _events The conversation so far. Ignored: the script is fixed.
   * @returns The next turn, or `STOP_SIGNAL_DETECTED` once the script ends.
   */
  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.invocationIdx >= this.staticConversation.length) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }

    const userMessage = this.staticConversation[this.invocationIdx].userContent;
    this.invocationIdx++;
    return {status: UserSimulatorStatus.SUCCESS, userMessage};
  }

  /**
   * Returns `undefined`: a replayed script cannot deviate, so there is nothing
   * to score.
   */
  getSimulationEvaluator(): Evaluator | undefined {
    return undefined;
  }
}
