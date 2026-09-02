/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {GenerateContentConfig} from '@google/genai';

import {logger} from '../utils/logger.js';

/**
 * Reasoning effort levels Claude accepts for adaptive extended thinking.
 *
 * Claude offers five levels while genai's `ThinkingLevel` defines four, so the
 * two cannot map onto each other consistently. Set this instead of
 * `thinkingConfig.thinkingLevel` on a Claude model.
 */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Generation config for Claude models.
 *
 * `effort` is the recommended way to control reasoning depth on newer Claude
 * models, and replaces the deprecated manual `thinkingConfig.thinkingBudget`.
 * Setting `effort` together with `thinkingConfig.thinkingLevel` is rejected.
 */
export interface AnthropicGenerateContentConfig extends GenerateContentConfig {
  /** Reasoning effort for adaptive extended thinking. */
  effort?: AnthropicEffort;
}

/**
 * Rejects a config that asks for a reasoning depth two different ways.
 *
 * adk-python makes this state unconstructable with a pydantic validator. A
 * TypeScript interface cannot validate at construction, so the check runs on
 * every request instead, from the effort mapping below.
 *
 * @param config The config to check.
 * @throws If both `effort` and `thinkingConfig.thinkingLevel` are set.
 */
export function validateAnthropicGenerateContentConfig(
  config?: AnthropicGenerateContentConfig,
): void {
  if (config?.effort && config.thinkingConfig?.thinkingLevel) {
    throw new Error(
      'thinkingLevel is not supported in AnthropicGenerateContentConfig. ' +
        'Use the `effort` field directly to configure reasoning effort.',
    );
  }
}

/**
 * Maps genai's `thinkingConfig` onto Anthropic's `thinking` parameter.
 *
 * `thinkingBudget` decides the mode: `0` disables thinking, a negative value
 * (genai's AUTOMATIC is `-1`) selects adaptive thinking, and a positive value
 * is a manual token budget. Adaptive is required by Claude Opus 4.7, which
 * rejects the manual mode with a 400. The `>= 1024` and `< maxTokens` limits
 * on a manual budget stay with the Anthropic API so the caller gets its
 * canonical error message.
 *
 * @param config The generation config, if any.
 * @return The `thinking` parameter, or `undefined` to omit it.
 * @throws If `thinkingConfig` is present without a `thinkingBudget`.
 */
export function buildThinkingParam(
  config?: GenerateContentConfig,
): Anthropic.ThinkingConfigParam | undefined {
  if (!config?.thinkingConfig) {
    return undefined;
  }
  const thinkingBudget = config.thinkingConfig.thinkingBudget;
  if (typeof thinkingBudget !== 'number') {
    throw new Error(
      'thinkingBudget must be set explicitly when thinkingConfig is provided ' +
        'for Anthropic models. Use 0 to disable thinking, -1 for adaptive ' +
        '(model-chosen depth), or a positive integer (>= 1024) for manual ' +
        'budgeting.',
    );
  }
  if (thinkingBudget === 0) {
    return {type: 'disabled'};
  }
  if (thinkingBudget < 0) {
    return {type: 'adaptive'};
  }
  return {type: 'enabled', budget_tokens: thinkingBudget};
}

/**
 * Reads the Anthropic reasoning effort out of a generation config.
 *
 * A `thinkingConfig.thinkingLevel` set on its own is ignored with a warning,
 * because genai's four levels do not map onto Claude's five efforts.
 *
 * @param config The generation config, if any.
 * @return The effort level, or `undefined` to omit `output_config`.
 * @throws If both `effort` and `thinkingConfig.thinkingLevel` are set.
 */
export function buildEffortParam(
  config?: AnthropicGenerateContentConfig,
): AnthropicEffort | undefined {
  validateAnthropicGenerateContentConfig(config);
  if (config?.effort) {
    return config.effort;
  }
  if (config?.thinkingConfig?.thinkingLevel) {
    logger.warn(
      'Standard thinkingConfig.thinkingLevel is not supported for Anthropic ' +
        'models and will be ignored. Use AnthropicGenerateContentConfig and ' +
        'set the `effort` field directly to configure reasoning effort.',
    );
  }
  return undefined;
}
