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
import {ConversationScenario} from '../conversation_scenarios.js';
import {Evaluator} from '../evaluator.js';

/**
 * Name of {@link BaseUserSimulatorConfig}, used as its discriminator when a
 * config names no `type`, and in the error a rejected config carries.
 *
 * adk-python keys its registry on the config class itself and reports
 * `type(config).__name__`, which is this string for a bare base config.
 */
export const BASE_USER_SIMULATOR_CONFIG_NAME = 'BaseUserSimulatorConfig';

/**
 * Base shape of every user simulator configuration.
 *
 * A concrete config locks {@link type} to one value and adds its own fields.
 * The base keeps unrecognized keys, so reading a concrete config as a base one
 * does not drop the fields the base does not name.
 */
export interface BaseUserSimulatorConfig {
  /**
   * Selects the simulator that consumes this config.
   *
   * Absent on the base, and absence is not a dispatchable value: a bare
   * `{}` resolves to no simulator rather than to a default one. A concrete
   * config locks this to a value unique to itself, such as `'llm_backed'`.
   */
  type?: string;
}

/** Validates a {@link BaseUserSimulatorConfig} payload. */
const baseUserSimulatorConfigModel: EvalModel<BaseUserSimulatorConfig> =
  evalModel(
    {type: optionalField(z.string())},
    {name: BASE_USER_SIMULATOR_CONFIG_NAME, extraKeys: 'allow'},
  );

/**
 * Reads `raw` as a {@link BaseUserSimulatorConfig}, keeping the keys the base
 * does not name.
 *
 * @param raw The config as it arrives, typically parsed from an eval config
 *     JSON file.
 * @returns The validated config.
 * @throws {InputValidationError} If `raw` is not a valid base config.
 */
export function parseBaseUserSimulatorConfig(
  raw: unknown,
): BaseUserSimulatorConfig {
  return unpackUserSimulatorConfig(raw, baseUserSimulatorConfigModel);
}

/**
 * Narrows a config to the shape one simulator accepts.
 *
 * A simulator calls this on the config it is handed, passing its own model, so
 * that a config meant for another simulator fails at construction rather than
 * part-way through a conversation. adk-python does the same work in
 * `UserSimulator.__init__`.
 *
 * @param config The config to narrow.
 * @param model The concrete simulator's own model.
 * @returns The config, narrowed, with unknown keys preserved.
 * @throws {InputValidationError} If `model` rejects `config`. The schema error
 *     naming the field that failed is kept as `cause`.
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
   * Returns the evaluator that scores whether the simulation itself went well,
   * or `undefined` when the simulator has nothing to score.
   *
   * A simulator that replays a fixed script has nothing to score, because it
   * cannot deviate from the script. One that generates its turns can.
   */
  getSimulationEvaluator?(): Evaluator | undefined;
}

/**
 * Builds a simulator that drives one conversation scenario.
 *
 * Counterpart of adk-python's `_ScenarioUserSimulatorFactory` protocol.
 */
export type UserSimulatorFactory = (params: {
  config: BaseUserSimulatorConfig;
  conversationScenario: ConversationScenario;
}) => UserSimulator;

/**
 * The simulator registered for each config discriminator.
 *
 * The registry lives beside the {@link UserSimulator} interface rather than on
 * `UserSimulatorProvider`, so a simulator module can register itself at import
 * time without the provider and the simulator importing each other.
 */
const simulatorByConfigType = new Map<string, UserSimulatorFactory>();

/**
 * Registers the simulator that consumes configs carrying `configType`.
 *
 * This is the extension point for a new simulator: ship a config whose `type`
 * is unique to it, call this once when the module loads, and
 * `UserSimulatorProvider.provide` dispatches to it. Registering a
 * discriminator twice keeps the later factory, so a test or an out-of-tree
 * package can swap an implementation without unregistering first.
 *
 * @param configType The `type` discriminator the factory answers to.
 * @param factory Builds the simulator.
 */
export function registerUserSimulator(
  configType: string,
  factory: UserSimulatorFactory,
): void {
  simulatorByConfigType.set(configType, factory);
}

/**
 * Removes the registration for `configType`.
 *
 * @param configType The discriminator to remove.
 * @returns Whether a registration was present.
 */
export function unregisterUserSimulator(configType: string): boolean {
  return simulatorByConfigType.delete(configType);
}

/**
 * Returns the factory registered for `configType`, or `undefined` when none
 * is.
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
