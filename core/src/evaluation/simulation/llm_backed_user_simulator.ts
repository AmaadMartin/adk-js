/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {evalModel, type EvalModel} from '../common.js';
import {
  llmUserSimulatorConfigShape,
  type LlmUserSimulatorConfig,
} from './user_simulator.js';

/** The `type` an eval config writes to select the LLM-backed simulator. */
export const LLM_BACKED_USER_SIMULATOR_TYPE = 'llm_backed';

/**
 * Configuration for a user simulator that prompts an LLM for the user's turns.
 *
 * This package models the configuration only. The simulator that reads it is
 * not ported yet, so a config validated here is what an eval config carries
 * rather than something adk-js can run.
 */
export interface LlmBackedUserSimulatorConfig extends LlmUserSimulatorConfig {
  type: typeof LLM_BACKED_USER_SIMULATOR_TYPE;
}

/**
 * Validates an {@link LlmBackedUserSimulatorConfig} payload.
 *
 * A payload that names no `type` gets this one, so a caller can validate a
 * section on its own without repeating the discriminator.
 */
export const llmBackedUserSimulatorConfigModel: EvalModel<LlmBackedUserSimulatorConfig> =
  evalModel(
    {
      type: z
        .literal(LLM_BACKED_USER_SIMULATOR_TYPE)
        .default(LLM_BACKED_USER_SIMULATOR_TYPE),
      ...llmUserSimulatorConfigShape,
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
