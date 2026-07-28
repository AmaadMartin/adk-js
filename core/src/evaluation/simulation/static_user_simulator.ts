/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {experimental} from '../../utils/experimental.js';
import {Invocation} from '../eval_case.js';

import {NextUserMessage, Status, UserSimulator} from './user_simulator.js';

/**
 * A {@link UserSimulator} that replays a pre-authored, static list of user
 * messages, one per invocation, in order.
 */
@experimental
export class StaticUserSimulator extends UserSimulator {
  private invocationIdx = 0;

  /**
   * @param staticConversation The pre-authored invocations whose user content
   *     is replayed turn by turn.
   */
  constructor(private readonly staticConversation: Invocation[]) {
    super();
  }

  override async getNextUserMessage(
    // Static replay ignores the conversation history.
    _events: Event[],
  ): Promise<NextUserMessage> {
    if (this.invocationIdx >= this.staticConversation.length) {
      return {status: Status.STOP_SIGNAL_DETECTED};
    }

    const userMessage = this.staticConversation[this.invocationIdx].userContent;
    this.invocationIdx += 1;
    return {status: Status.SUCCESS, userMessage};
  }
}
