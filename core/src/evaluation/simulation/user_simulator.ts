/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Event} from '../../events/event.js';
import {EvalCase} from '../eval_case.js';

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

/**
 * Base configuration for a user simulator.
 *
 * `type` is the discriminator a concrete simulator registers under, and the
 * base carries none of its own: a config without a `type` names no simulator.
 * A concrete simulator ships its own config extending this one, pinning
 * `type` to the literal it registered.
 */
export interface BaseUserSimulatorConfig {
  /**
   * Names the simulator implementation this config belongs to, as passed to
   * {@link registerUserSimulator}.
   */
  type?: string;
}

/** Builds the simulator registered for a config type, for one eval case. */
export type UserSimulatorFactory = (params: {
  config: BaseUserSimulatorConfig;
  evalCase: EvalCase;
}) => UserSimulator;

const SIMULATOR_BY_CONFIG_TYPE = new Map<string, UserSimulatorFactory>();

/**
 * Registers the simulator that a config `type` selects.
 *
 * This is the extension point for new simulator types. A simulator ships its
 * own config type and calls this once from its own module, at import time.
 * Registering a type that is already registered replaces its factory.
 *
 * @param type The `type` discriminator the config carries.
 * @param factory Builds the simulator for one eval case.
 */
export function registerUserSimulator(
  type: string,
  factory: UserSimulatorFactory,
): void {
  SIMULATOR_BY_CONFIG_TYPE.set(type, factory);
}

/**
 * The factories registered so far, keyed by config `type`.
 *
 * The registry lives on this module rather than on `UserSimulatorProvider` so
 * that a simulator can register itself from its own module without importing
 * the provider, which imports every built-in simulator in turn.
 *
 * @returns A read-only view of the registry.
 */
export function userSimulatorRegistry(): ReadonlyMap<
  string,
  UserSimulatorFactory
> {
  return SIMULATOR_BY_CONFIG_TYPE;
}

/**
 * Message of the error {@link validateNextUserMessage} throws. Matches
 * adk-python's `NextUserMessage` validator.
 */
const USER_MESSAGE_IFF_SUCCESS_ERROR =
  'A user_message should be provided if and only if the status is SUCCESS';

/**
 * Checks the invariant a {@link NextUserMessage} must hold: a `userMessage` is
 * present if and only if the status is `SUCCESS`.
 *
 * adk-python enforces this in the model validator that runs when a
 * `NextUserMessage` is constructed. `NextUserMessage` is a plain interface
 * here, so the caller applies the check on the value a simulator returns.
 *
 * @param next The result to check.
 * @throws {Error} If the message and the status disagree.
 */
export function validateNextUserMessage(next: NextUserMessage): void {
  const isSuccess = next.status === UserSimulatorStatus.SUCCESS;
  const hasMessage = next.userMessage !== undefined;
  if (isSuccess !== hasMessage) {
    throw new Error(USER_MESSAGE_IFF_SUCCESS_ERROR);
  }
}
