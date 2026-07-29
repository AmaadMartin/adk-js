/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Event} from '../../events/event.js';
import {experimental} from '../../utils/experimental.js';
import {ConversationScenario} from '../conversation_scenarios.js';
import {Evaluator} from '../eval_case.js';

/**
 * Base class for configurations pertaining to a user simulator.
 *
 * Concrete subclasses lock `type` to a `Literal[...]` value unique to that
 * subclass (e.g. `'llm_backed'`). The runtime class identity of a config is the
 * dispatch key used by {@link registerUserSimulator} /
 * `UserSimulatorProvider`.
 */
export class BaseUserSimulatorConfig {
  /**
   * Discriminator for the concrete config subclass. `undefined` on the base --
   * a bare `BaseUserSimulatorConfig` cannot be dispatched to any simulator.
   */
  type?: string;

  /**
   * Creates a `BaseUserSimulatorConfig`.
   *
   * @param data Config data carrying the optional `type` discriminator.
   */
  constructor(data: {type?: string} = {}) {
    this.type = data.type;
  }
}

/** The resulting status of {@link UserSimulator.getNextUserMessage}. */
export enum Status {
  /** A message was generated successfully. */
  SUCCESS = 'success',
  /** The maximum number of invocations was reached. */
  TURN_LIMIT_REACHED = 'turn_limit_reached',
  /** The simulator emitted its stop signal. */
  STOP_SIGNAL_DETECTED = 'stop_signal_detected',
  /**
   * No message could be generated, and the conversation should end cleanly.
   *
   * Part of the base contract for simulator implementations, not a state any
   * built-in simulator reaches: `LlmBackedUserSimulator` treats a failure to
   * generate as an error and throws (parity with adk-python, which documents
   * the raise as "different from the NO_MESSAGE_GENERATED status"), and
   * `StaticUserSimulator` returns `STOP_SIGNAL_DETECTED` when its replay is
   * exhausted.
   */
  NO_MESSAGE_GENERATED = 'no_message_generated',
}

/** Initializer for a {@link NextUserMessage}. */
export interface NextUserMessageInit {
  /** The resulting status. */
  status: Status;
  /** The next user message; required iff `status` is `SUCCESS`. */
  userMessage?: Content;
}

/**
 * The result of {@link UserSimulator.getNextUserMessage}.
 *
 * Enforces the invariant that a `userMessage` is present if and only if the
 * status is `SUCCESS`.
 */
export class NextUserMessage {
  /** The resulting status of `getNextUserMessage()`. */
  readonly status: Status;

  /** The next user message, present iff `status` is `SUCCESS`. */
  readonly userMessage?: Content;

  /**
   * Creates a `NextUserMessage`.
   *
   * @param init The status and optional message.
   * @throws {Error} If a `userMessage` is present without a `SUCCESS` status, or
   *     absent with a `SUCCESS` status.
   */
  constructor(init: NextUserMessageInit) {
    const isSuccess = init.status === Status.SUCCESS;
    const hasMessage = init.userMessage !== undefined;
    if (isSuccess !== hasMessage) {
      throw new Error(
        'A user_message should be provided if and only if the status is' +
          ' SUCCESS',
      );
    }
    this.status = init.status;
    this.userMessage = init.userMessage;
  }
}

/**
 * A user simulator that automates interaction with an agent under evaluation.
 *
 * Typically you create one user-simulator instance per eval case.
 */
@experimental
export class UserSimulator {
  /**
   * Returns the next user message to send to the agent.
   *
   * @param _events The unaltered conversation history between the user and the
   *     agent(s) under evaluation.
   * @returns The next user message, or a status explaining why none was
   *     generated.
   */
  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    throw new Error('Not implemented.');
  }

  /**
   * Returns an evaluator that assesses whether the user simulation succeeded.
   *
   * @returns An {@link Evaluator}, or `undefined` if none is required.
   */
  getSimulationEvaluator(): Evaluator | undefined {
    throw new Error('Not implemented.');
  }
}

/** A constructor for a {@link BaseUserSimulatorConfig} subclass. */
export type BaseUserSimulatorConfigClass = new (
  ...args: never[]
) => BaseUserSimulatorConfig;

/**
 * A constructor for a {@link UserSimulator} subclass, as invoked by
 * `UserSimulatorProvider`.
 *
 * The provider mixes the shared config with the eval case's scenario, so a
 * registered simulator is always constructed with both. Simulators that ignore
 * one or both may declare a narrower constructor (or none at all) -- a
 * constructor taking fewer parameters stays assignable to this type.
 */
export type UserSimulatorClass = new (args: {
  config: BaseUserSimulatorConfig;
  conversationScenario: ConversationScenario;
}) => UserSimulator;

/**
 * Maps a concrete `BaseUserSimulatorConfig` subclass to the `UserSimulator`
 * implementation that consumes it.
 *
 * Lives on this base module (rather than the provider) so new simulator
 * subclasses can self-register from their own module at import time without a
 * circular dependency. `UserSimulatorProvider` reads it to dispatch by config
 * type.
 */
export const SIMULATOR_BY_CONFIG_TYPE = new Map<
  BaseUserSimulatorConfigClass,
  UserSimulatorClass
>();

/**
 * Registers a `UserSimulator` implementation for a given config subclass.
 *
 * This is the extension point for new user-simulator types. Re-registering the
 * same config type overwrites the prior entry.
 *
 * @param configType The concrete `BaseUserSimulatorConfig` subclass.
 * @param simulatorType The `UserSimulator` subclass that consumes it.
 */
export function registerUserSimulator(
  configType: BaseUserSimulatorConfigClass,
  simulatorType: UserSimulatorClass,
): void {
  SIMULATOR_BY_CONFIG_TYPE.set(configType, simulatorType);
}
