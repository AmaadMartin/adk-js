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

/**
 * A unique symbol to identify BuiltInPlanner classes.
 * Defined once and shared by all BuiltInPlanner instances.
 */
const BUILT_IN_PLANNER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.builtInPlanner',
);

/**
 * Type guard to check if an object is an instance of BuiltInPlanner.
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
 * The built-in planner that uses the model's built-in thinking features.
 *
 * The planner contributes no system instruction and does no response
 * post-processing: it only stamps its {@link thinkingConfig} onto the request.
 */
export class BuiltInPlanner extends BasePlanner {
  /** A unique symbol to identify BuiltInPlanner classes. */
  readonly [BUILT_IN_PLANNER_SIGNATURE_SYMBOL] = true;

  /**
   * Config for the model's built-in thinking features. The model returns an
   * error if this is set for a model that does not support thinking.
   */
  readonly thinkingConfig: ThinkingConfig;

  /**
   * @param options.thinkingConfig Config for the model's built-in thinking
   *     features.
   */
  constructor(options: {thinkingConfig: ThinkingConfig}) {
    super();
    this.thinkingConfig = options.thinkingConfig;
  }

  /**
   * Applies the thinking config to the LLM request, replacing any thinking
   * config the agent's `generateContentConfig` already set.
   *
   * @param llmRequest The LLM request to apply the thinking config to.
   */
  applyThinkingConfig(llmRequest: LlmRequest): void {
    if (!llmRequest.config) {
      llmRequest.config = {};
    }
    if (llmRequest.config.thinkingConfig) {
      logger.debug(
        'Overwriting `thinkingConfig` from `generateContentConfig` with the ' +
          'one provided by the `BuiltInPlanner`.',
      );
    }
    llmRequest.config.thinkingConfig = this.thinkingConfig;
  }

  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return undefined;
  }
}
