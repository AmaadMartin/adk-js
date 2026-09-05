/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Event} from '../../events/event.js';

/** The resulting status of {@link UserSimulator.getNextUserMessage}. */
export enum UserSimulatorStatus {
  /** A message was generated successfully. */
  SUCCESS = 'success',

  /** The maximum number of invocations was reached. */
  TURN_LIMIT_REACHED = 'turn_limit_reached',

  /** The simulator emitted its stop signal. */
  STOP_SIGNAL_DETECTED = 'stop_signal_detected',

  /** No message could be generated, and the conversation should end. */
  NO_MESSAGE_GENERATED = 'no_message_generated',
}

/** The result of {@link UserSimulator.getNextUserMessage}. */
export interface NextUserMessage {
  /**
   * Why the call ended. The caller inspects this to decide whether the
   * conversation continues.
   */
  status: UserSimulatorStatus;

  /** The next user message. Present if and only if `status` is `SUCCESS`. */
  userMessage?: Content;
}

/**
 * Drives the user side of a conversation with the agent under evaluation.
 *
 * Create one simulator per eval case; a simulator is stateful across the turns
 * of the conversation it drives.
 */
export interface UserSimulator {
  /**
   * Returns the next user message to send to the agent.
   *
   * @param events The conversation so far between the user and the agent(s)
   *     under evaluation.
   * @returns The next user message, or a status explaining why there is none.
   */
  getNextUserMessage(events: Event[]): Promise<NextUserMessage>;
}
