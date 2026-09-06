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
 * A unique symbol to identify BasePlanner classes.
 * Defined once and shared by all BasePlanner instances.
 */
const BASE_PLANNER_SIGNATURE_SYMBOL = Symbol.for('google.adk.basePlanner');

/** The parameters for building a planning instruction. */
export interface BuildPlanningInstructionParams {
  /** The readonly context of the invocation. */
  readonlyContext: ReadonlyContext;
  /** The LLM request. Readonly. */
  llmRequest: LlmRequest;
}

/** The parameters for processing a planning response. */
export interface ProcessPlanningResponseParams {
  /** The callback context of the invocation. */
  context: Context;
  /** The LLM response parts. */
  responseParts: Part[];
}

/**
 * Type guard to check if an object is an instance of BasePlanner.
 * @param obj The object to check.
 * @returns True if the object is an instance of BasePlanner, false otherwise.
 */
export function isBasePlanner(obj: unknown): obj is BasePlanner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_PLANNER_SIGNATURE_SYMBOL in obj &&
    obj[BASE_PLANNER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The planner allows the agent to generate plans for the queries to guide its
 * action.
 *
 * Attach an implementation to an agent through its `planner` field.
 */
export abstract class BasePlanner {
  /** A unique symbol to identify BasePlanner class. */
  readonly [BASE_PLANNER_SIGNATURE_SYMBOL] = true;

  /**
   * Builds the system instruction appended to the LLM request for planning.
   *
   * @returns The planning system instruction, or `undefined` when the request
   *     needs no instruction. A planner that fetches its instruction may
   *     return a promise.
   */
  abstract buildPlanningInstruction(
    params: BuildPlanningInstructionParams,
  ): string | undefined | Promise<string | undefined>;

  /**
   * Processes the LLM response for planning.
   *
   * @returns The replacement response parts, or `undefined` to keep the parts
   *     the model returned. A planner that defers the work may return a
   *     promise.
   */
  abstract processPlanningResponse(
    params: ProcessPlanningResponseParams,
  ): Part[] | undefined | Promise<Part[] | undefined>;
}
