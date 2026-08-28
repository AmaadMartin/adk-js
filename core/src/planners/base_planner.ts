/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';

/**
 * The contract for all planners.
 *
 * A planner lets an agent produce a plan for the query before it acts on the
 * query. Attach an implementation to an agent through its `planner` field.
 */
export interface BasePlanner {
  /**
   * Builds the system instruction appended to the LLM request for planning.
   *
   * @param readonlyContext The readonly context of the invocation.
   * @param llmRequest The LLM request. Readonly.
   * @returns The planning system instruction, or `undefined` when the request
   *     needs no instruction.
   */
  buildPlanningInstruction(
    readonlyContext: ReadonlyContext,
    llmRequest: LlmRequest,
  ): string | undefined;

  /**
   * Processes the LLM response for planning.
   *
   * @param callbackContext The callback context of the invocation.
   * @param responseParts The LLM response parts.
   * @returns The replacement response parts, or `undefined` to keep the parts
   *     the model returned.
   */
  processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined;
}
