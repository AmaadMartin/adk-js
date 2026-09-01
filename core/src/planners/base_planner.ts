/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

import type {Context} from '../agents/context.js';
import type {ReadonlyContext} from '../agents/readonly_context.js';
import type {LlmRequest} from '../models/llm_request.js';

/**
 * The contract for all planners.
 *
 * A planner lets an agent generate a plan for a query, and guides the actions
 * the agent takes to answer it.
 */
export interface BasePlanner {
  /**
   * Builds the system instruction appended to the LLM request for planning.
   *
   * @param readonlyContext The readonly context of the invocation.
   * @param llmRequest The LLM request. Readonly.
   * @returns The planning system instruction, or `undefined` when no
   *     instruction is needed.
   */
  buildPlanningInstruction(
    readonlyContext: ReadonlyContext,
    llmRequest: LlmRequest,
  ): string | undefined | Promise<string | undefined>;

  /**
   * Processes the LLM response for planning.
   *
   * @param callbackContext The callback context of the invocation.
   * @param responseParts The LLM response parts. Readonly.
   * @returns The processed response parts, or `undefined` when no processing
   *     is needed.
   */
  processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined | Promise<Part[] | undefined>;
}
