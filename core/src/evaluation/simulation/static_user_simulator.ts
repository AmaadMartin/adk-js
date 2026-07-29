/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {experimental} from '../../utils/experimental.js';
import {Evaluator, StaticConversation} from '../eval_case.js';
import {NextUserMessage, Status, UserSimulator} from './user_simulator.js';

/**
 * A {@link UserSimulator} that replays a static list of user messages.
 */
@experimental
export class StaticUserSimulator extends UserSimulator {
  /** The static conversation being replayed. */
  readonly staticConversation: StaticConversation;

  private invocationIdx = 0;

  /**
   * Creates a `StaticUserSimulator` that replays the given pre-authored
   * conversation.
   */
  constructor({staticConversation}: {staticConversation: StaticConversation}) {
    super();
    this.staticConversation = staticConversation;
  }

  /**
   * Returns the next user message from the static list, in order, then
   * `STOP_SIGNAL_DETECTED` once the list is exhausted.
   *
   * @param _events Unused; present for interface compatibility.
   * @returns The next user message or a stop status.
   */
  override async getNextUserMessage(
    _events: Event[],
  ): Promise<NextUserMessage> {
    if (this.invocationIdx >= this.staticConversation.length) {
      return new NextUserMessage({status: Status.STOP_SIGNAL_DETECTED});
    }
    const nextUserContent =
      this.staticConversation[this.invocationIdx].userContent;
    this.invocationIdx += 1;
    return new NextUserMessage({
      status: Status.SUCCESS,
      userMessage: nextUserContent,
    });
  }

  /**
   * The `StaticUserSimulator` does not require an evaluator.
   *
   * @returns `undefined`.
   */
  override getSimulationEvaluator(): Evaluator | undefined {
    return undefined;
  }
}
