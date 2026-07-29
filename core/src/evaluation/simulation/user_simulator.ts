/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Event} from '../../events/event.js';

/**
 * The resulting status of {@link UserSimulator.getNextUserMessage}.
 *
 * String values mirror adk-python's serialized form.
 */
export enum Status {
  /** A user message was generated successfully. */
  SUCCESS = 'success',
  /** The maximum number of conversation turns was reached. */
  TURN_LIMIT_REACHED = 'turn_limit_reached',
  /** A stop signal was detected, ending the conversation. */
  STOP_SIGNAL_DETECTED = 'stop_signal_detected',
  /** No message was generated for some other reason. */
  NO_MESSAGE_GENERATED = 'no_message_generated',
}

/**
 * The next user message produced by a {@link UserSimulator}, or a status
 * explaining why no message was generated.
 *
 * A `userMessage` is present if and only if `status` is {@link Status.SUCCESS}.
 */
export interface NextUserMessage {
  /** The resulting status of the message-generation attempt. */
  status: Status;
  /** The next user message. Present iff `status` is {@link Status.SUCCESS}. */
  userMessage?: Content;
}

/**
 * Automates interaction with an agent under evaluation by producing the next
 * user message given the conversation so far.
 *
 * Typically one simulator instance is created per eval case.
 */
export abstract class UserSimulator {
  /**
   * Returns the next user message to send to the agent.
   *
   * @param events The unaltered conversation history between the user and the
   *     agent(s) under evaluation.
   * @returns A {@link NextUserMessage} with the next user message, or a status
   *     indicating why no message was generated.
   */
  abstract getNextUserMessage(events: Event[]): Promise<NextUserMessage>;
}
