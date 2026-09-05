/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part, ThinkingConfig} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';

import {BasePlanner} from './base_planner.js';

const BUILT_IN_PLANNER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.builtInPlanner',
);

/**
 * Type guard to check if an object is a BuiltInPlanner.
 *
 * @param obj The object to check.
 * @returns True if the object is a BuiltInPlanner, false otherwise.
 */
export function isBuiltInPlanner(obj: unknown): obj is BuiltInPlanner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BUILT_IN_PLANNER_SIGNATURE_SYMBOL in obj &&
    obj[BUILT_IN_PLANNER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The options for creating a BuiltInPlanner.
 */
export interface BuiltInPlannerOptions {
  /** @see BuiltInPlanner.thinkingConfig */
  thinkingConfig: ThinkingConfig;
}

/**
 * The planner that uses the model's built-in thinking features.
 *
 * It contributes no planning instruction of its own. It carries a thinking
 * config onto the outgoing request and lets the model plan for itself.
 *
 * The planner's config always wins. `applyThinkingConfig` replaces a
 * `thinkingConfig` the request already carried from `generateContentConfig`,
 * and logs the replacement at debug level.
 *
 * Use the {@link isBuiltInPlanner} guard rather than `instanceof` to identify
 * one at runtime: the guard reads a `Symbol.for` brand, so it still answers
 * correctly when two copies of `@google/adk` share one runtime.
 */
export class BuiltInPlanner implements BasePlanner {
  readonly [BUILT_IN_PLANNER_SIGNATURE_SYMBOL] = true;

  /**
   * Config for the model's built-in thinking features. The model returns an
   * error if this is set for a model that does not support thinking.
   */
  readonly thinkingConfig: ThinkingConfig;

  constructor({thinkingConfig}: BuiltInPlannerOptions) {
    this.thinkingConfig = thinkingConfig;
  }

  /**
   * Applies the thinking config to the LLM request, in place.
   *
   * @param llmRequest The LLM request to apply the thinking config to.
   */
  applyThinkingConfig(llmRequest: LlmRequest): void {
    if (llmRequest.config?.thinkingConfig) {
      // Verbatim from adk-python; its test asserts this text.
      logger.debug(
        'Overwriting `thinking_config` from `generate_content_config` with ' +
          'the one provided by the `BuiltInPlanner`.',
      );
    }
    llmRequest.config ??= {};
    llmRequest.config.thinkingConfig = this.thinkingConfig;
  }

  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return undefined;
  }
}
