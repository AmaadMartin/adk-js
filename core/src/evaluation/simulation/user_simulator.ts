/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {z} from 'zod';

import {InputValidationError} from '../../errors/input_validation_error.js';
import {Event} from '../../events/event.js';
import {EvalModel, evalModel, optionalField} from '../common.js';
import type {ConversationScenario} from '../conversation_scenarios.js';
import type {Evaluator} from '../evaluator.js';

/** The name the base config is reported under in a validation error. */
export const BASE_USER_SIMULATOR_CONFIG_NAME = 'BaseUserSimulatorConfig';

/**
 * Base shape for a user simulator's configuration.
 *
 * `type` selects the simulator: {@link registerUserSimulator} keys the
 * registry by it, and `UserSimulatorProvider` dispatches on it. It is absent
 * on the base, which is not a dispatchable value on its own — a bare config
 * must be promoted to a concrete one first.
 *
 * A concrete config adds its own fields and locks `type` to a single value.
 * Unknown keys are preserved rather than rejected, matching adk-python's
 * `extra="allow"`; the named fields here are the ones adk-js reads.
 */
export interface BaseUserSimulatorConfig {
  type?: string;
}

const baseUserSimulatorConfigModel: EvalModel<BaseUserSimulatorConfig> =
  evalModel(
    {type: optionalField(z.string())},
    {name: BASE_USER_SIMULATOR_CONFIG_NAME, extraKeys: 'allow'},
  );

/**
 * Validates a value against a concrete simulator's own config model.
 *
 * This is adk-js's counterpart of the unpacking adk-python does in
 * `UserSimulator.__init__`. `UserSimulator` is an interface here, so a
 * concrete simulator calls this from its own constructor, the way
 * {@link validateNextUserMessage} sits beside the {@link NextUserMessage}
 * interface.
 *
 * @param config The config the caller supplied.
 * @param model The concrete simulator's own model. Its `name` is what the
 *   error reports.
 * @returns The config, narrowed to the concrete shape.
 * @throws {InputValidationError} If the config does not match the model. The
 *   underlying schema error is kept as the `cause`.
 */
export function unpackUserSimulatorConfig<T extends BaseUserSimulatorConfig>(
  config: unknown,
  model: EvalModel<T>,
): T {
  const result = model.schema.safeParse(config);
  if (!result.success) {
    throw new InputValidationError(`Expect config of type \`${model.name}\`.`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Validates a value as a {@link BaseUserSimulatorConfig}.
 *
 * @param raw The value to validate.
 * @returns The value, with its unknown keys preserved.
 * @throws {InputValidationError} If the value is not a config object.
 */
export function parseBaseUserSimulatorConfig(
  raw: unknown,
): BaseUserSimulatorConfig {
  return unpackUserSimulatorConfig(raw, baseUserSimulatorConfigModel);
}

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

  /**
   * Returns the evaluator that scores whether the simulation itself went as
   * intended, so an eval run can grade the simulated user alongside the agent.
   *
   * Optional: a simulator with nothing to score omits the method, which is
   * adk-js's reading of the `None` adk-python's `StaticUserSimulator` returns.
   * Call it as `simulator.getSimulationEvaluator?.()`.
   */
  getSimulationEvaluator?(): Evaluator | undefined;
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

/** Builds the simulator registered for one config discriminator. */
export type UserSimulatorFactory = (params: {
  /** The config the caller gave `UserSimulatorProvider`. */
  config: BaseUserSimulatorConfig;

  /** The scenario the eval case describes. */
  conversationScenario: ConversationScenario;
}) => UserSimulator;

/**
 * The simulator registered for each config discriminator.
 *
 * The registry lives on this module rather than on the provider so a new
 * simulator can register itself from its own module without importing the
 * provider back.
 */
const simulatorByConfigType = new Map<string, UserSimulatorFactory>();

/**
 * Registers the simulator that a config discriminator selects.
 *
 * This is the extension point for a new simulator: it ships a config with a
 * `type` of its own and calls this once, at import time. `provide` then
 * dispatches to it with no change to adk-js. Registering a discriminator
 * twice keeps the later factory.
 *
 * @param configType The `type` discriminator of the simulator's config.
 * @param factory Builds the simulator for one eval case.
 */
export function registerUserSimulator(
  configType: string,
  factory: UserSimulatorFactory,
): void {
  simulatorByConfigType.set(configType, factory);
}

/**
 * Returns the factory registered for `configType`, or `undefined` when
 * nothing is registered for it.
 */
export function getRegisteredUserSimulator(
  configType: string,
): UserSimulatorFactory | undefined {
  return simulatorByConfigType.get(configType);
}

/** Returns every registered discriminator, sorted. */
export function registeredUserSimulatorTypes(): string[] {
  return [...simulatorByConfigType.keys()].sort();
}
