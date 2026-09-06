/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {EvalModel, evalModel, optionalField} from '../common.js';
import {BaseUserSimulatorConfig} from './user_simulator.js';

/** The `type` of an {@link LlmBackedUserSimulatorConfig}. */
export const LLM_BACKED_USER_SIMULATOR_TYPE = 'llm_backed';

/** The model a simulator uses when its config names none. */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** The invocation limit a simulator uses when its config names none. */
const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;

/** The thinking budget of {@link defaultModelConfiguration}. */
const DEFAULT_THINKING_BUDGET = 10240;

/** Builds the model configuration a simulator uses when its config omits it. */
function defaultModelConfiguration(): GenerateContentConfig {
  return {
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    },
  };
}

/**
 * The settings every LLM-driven user simulator reads.
 *
 * adk-python repeats these fields on each concrete config. They are declared
 * once here, and each concrete config carries them.
 */
export interface LlmUserSimulatorFields {
  /** The model that writes the user's messages. */
  model: string;

  /** The configuration of {@link LlmUserSimulatorFields.model}. */
  modelConfiguration: GenerateContentConfig;

  /**
   * The invocations one simulated conversation may run, counting the opening
   * prompt. It ends a conversation in which the agent and the simulated user
   * answer each other forever. A value of -1 removes the limit, which is not
   * recommended.
   */
  maxAllowedInvocations: number;

  /**
   * Instructions that replace the built-in simulator prompt.
   *
   * The prompt reads the `stop_signal`, `conversation_plan` and
   * `conversation_history` Jinja placeholders, and reads `persona` when the
   * conversation scenario names one. adk-python rejects a template that
   * declares any of the first three itself; this package does not check the
   * template.
   */
  customInstructions?: string;

  /**
   * Whether the conversation history the simulator reads includes the
   * function calls and the function responses of the agent.
   */
  includeFunctionCalls: boolean;
}

/** The field shape of {@link LlmUserSimulatorFields}. */
export const llmUserSimulatorFieldsShape = {
  model: z.string().default(DEFAULT_MODEL),
  modelConfiguration: z
    .custom<GenerateContentConfig>()
    .default(defaultModelConfiguration),
  maxAllowedInvocations: z
    .number()
    .int()
    .default(DEFAULT_MAX_ALLOWED_INVOCATIONS),
  customInstructions: optionalField(z.string()),
  includeFunctionCalls: z.boolean().default(false),
};

/**
 * The settings of a user simulator that asks a model for the next user
 * message.
 */
export interface LlmBackedUserSimulatorConfig
  extends BaseUserSimulatorConfig, LlmUserSimulatorFields {
  type: typeof LLM_BACKED_USER_SIMULATOR_TYPE;
}

/** Validates an {@link LlmBackedUserSimulatorConfig} payload. */
const llmBackedUserSimulatorConfigModel: EvalModel<LlmBackedUserSimulatorConfig> =
  evalModel(
    {
      type: z
        .literal(LLM_BACKED_USER_SIMULATOR_TYPE)
        .default(LLM_BACKED_USER_SIMULATOR_TYPE),
      ...llmUserSimulatorFieldsShape,
    },
    {name: 'LlmBackedUserSimulatorConfig', extraKeys: 'allow'},
  );

/**
 * Validates an LLM-backed user simulator payload and applies every default.
 *
 * A key the config does not name is kept, so a simulator can read a setting
 * of its own out of a validated config.
 *
 * @throws {InputValidationError} When the payload names another `type`, or
 *   gives a field a value of the wrong kind.
 */
export function parseLlmBackedUserSimulatorConfig(
  raw: unknown,
): LlmBackedUserSimulatorConfig {
  return llmBackedUserSimulatorConfigModel.parse(raw);
}
