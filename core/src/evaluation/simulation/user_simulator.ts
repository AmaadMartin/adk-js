/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {Event} from '../../events/event.js';
import {optionalField} from '../common.js';

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

/**
 * Configuration common to every user simulator.
 *
 * adk-python declares `extra="allow"` on this model, so a key the shape does
 * not name is kept rather than dropped. The index signature is the counterpart
 * of that, and it is what lets a simulator read a setting this package does
 * not model.
 */
export interface BaseUserSimulatorConfig {
  /**
   * Names the concrete config. A concrete config narrows this to its own
   * literal, such as `'llm_backed'`. It is not a value a simulator can be
   * chosen by on its own: a base config must be promoted to a concrete one
   * first.
   */
  type?: string;

  [key: string]: unknown;
}

/** The model an LLM-backed user simulator prompts when a config names none. */
export const DEFAULT_USER_SIMULATOR_MODEL = 'gemini-2.5-flash';

/** The thinking budget an LLM-backed user simulator asks its model for. */
export const DEFAULT_USER_SIMULATOR_THINKING_BUDGET = 10240;

/** How many invocations a simulated conversation runs for by default. */
export const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;

/**
 * The settings every LLM-backed user simulator config carries.
 *
 * adk-python repeats these fields on each concrete config rather than sharing
 * a class; they are declared once here and both concrete configs extend them.
 */
export interface LlmUserSimulatorConfig extends BaseUserSimulatorConfig {
  /**
   * The model that generates the user's turns. Defaults to
   * {@link DEFAULT_USER_SIMULATOR_MODEL}.
   */
  model?: string;

  /**
   * The configuration for that model. Defaults to a thinking config of
   * {@link DEFAULT_USER_SIMULATOR_THINKING_BUDGET} tokens with thoughts
   * included.
   */
  modelConfiguration?: GenerateContentConfig;

  /**
   * How many invocations the simulated conversation may run for, which stops a
   * run-off conversation between the agent and the simulator. The opening
   * fixed prompt counts as one. Defaults to
   * {@link DEFAULT_MAX_ALLOWED_INVOCATIONS}; `-1` removes the limit, which is
   * not recommended.
   */
  maxAllowedInvocations?: number;

  /**
   * Instructions that replace the built-in simulator prompt. They must name
   * `stop_signal`, `conversation_plan` and `conversation_history`, each inside
   * a `{{ }}` pair.
   */
  customInstructions?: string;

  /**
   * Whether the conversation history given to the simulator includes function
   * calls and their responses. Defaults to false.
   */
  includeFunctionCalls?: boolean;
}

/**
 * The placeholders custom simulator instructions must name.
 *
 * adk-python parses the instructions as a Jinja template and reports the
 * variables it leaves undeclared. adk-js has no Jinja, so it checks that each
 * name appears inside a `{{ }}` pair instead.
 */
const REQUIRED_INSTRUCTION_PLACEHOLDERS = [
  'stop_signal',
  'conversation_plan',
  'conversation_history',
] as const;

const PLACEHOLDER_PATTERNS = REQUIRED_INSTRUCTION_PLACEHOLDERS.map(
  (name) => new RegExp(`\\{\\{[^{}]*\\b${name}\\b[^{}]*\\}\\}`),
);

/** Message adk-python raises when custom instructions omit a placeholder. */
const MISSING_INSTRUCTION_PLACEHOLDER_ERROR =
  'custom_instructions must contain each of the following formatting ' +
  'placeholders using Jinja syntax: {{ stop_signal }}, ' +
  '{{ conversation_plan }}, {{ conversation_history }}';

/**
 * Reports whether custom simulator instructions name every required
 * placeholder.
 *
 * @param instructions The instructions to check.
 * @returns Whether every placeholder appears inside a `{{ }}` pair.
 */
function hasRequiredInstructionPlaceholders(instructions: string): boolean {
  return PLACEHOLDER_PATTERNS.every((pattern) => pattern.test(instructions));
}

/** The shared field schemas of an LLM-backed user simulator config. */
export const llmUserSimulatorConfigShape = {
  model: z.string().default(DEFAULT_USER_SIMULATOR_MODEL),
  modelConfiguration: z.custom<GenerateContentConfig>().default(() => ({
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: DEFAULT_USER_SIMULATOR_THINKING_BUDGET,
    },
  })),
  maxAllowedInvocations: z
    .number()
    .int()
    .default(DEFAULT_MAX_ALLOWED_INVOCATIONS),
  customInstructions: optionalField(
    z.string().refine(hasRequiredInstructionPlaceholders, {
      error: MISSING_INSTRUCTION_PLACEHOLDER_ERROR,
    }),
  ),
  includeFunctionCalls: z.boolean().default(false),
};
