/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {EvalCase, Invocation} from './eval_case.js';

/**
 * The content of a rubric.
 */
export interface RubricContent {
  /**
   * The property being evaluated, e.g. "The agent's response is grammatically
   * correct.".
   */
  textProperty?: string;
}

/**
 * A single rubric.
 */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The testable criterion for the rubric. */
  rubricContent: RubricContent;

  /**
   * How to interpret the result of this rubric's assessment.
   */
  description?: string;

  /**
   * A type designator, which tells a system or a user how to evaluate the
   * rubric. Use consistent upper snake_case strings, e.g. "TOOL_USE_QUALITY",
   * "FINAL_RESPONSE_QUALITY", "INSTRUCTION_ADHERENCE".
   */
  type?: string;
}

/** The score obtained after applying a rubric to the agent's response. */
export interface RubricScore {
  /** The id of the rubric that was assessed. */
  rubricId: string;

  /** Reasoning for the score. */
  rationale?: string;

  /** Absent when the assessment did not happen. */
  score?: number;
}

/**
 * Appends rubrics to an invocation.
 *
 * @throws {InputValidationError} When a rubric repeats an id the invocation
 *   already carries.
 */
export function addRubricsToInvocation(
  invocation: Invocation,
  rubricsToAdd: Rubric[],
): void {
  if (!invocation.rubrics) {
    invocation.rubrics = [];
  }
  const existingIds = new Set(invocation.rubrics.map((r) => r.rubricId));
  for (const rubric of rubricsToAdd) {
    if (existingIds.has(rubric.rubricId)) {
      throw new InputValidationError(
        `Rubric with rubric_id '${rubric.rubricId}' already exists.`,
      );
    }
    invocation.rubrics.push(rubric);
    existingIds.add(rubric.rubricId);
  }
}

/** Copies the eval case's own rubrics onto every actual invocation. */
export function copyEvalCaseRubricsToActualInvocations(
  evalCase: EvalCase,
  actualInvocations: Invocation[],
): void {
  if (!evalCase.rubrics?.length) {
    return;
  }
  for (const invocation of actualInvocations) {
    addRubricsToInvocation(invocation, evalCase.rubrics);
  }
}

/**
 * Copies each expected invocation's rubrics onto the actual invocation in the
 * same position. Pairing stops at the shorter list, matching Python's `zip`.
 */
export function copyInvocationRubricsToActualInvocations(
  expectedInvocations: Invocation[] | undefined,
  actualInvocations: Invocation[],
): void {
  if (!expectedInvocations) {
    return;
  }
  const pairCount = Math.min(
    expectedInvocations.length,
    actualInvocations.length,
  );
  for (let index = 0; index < pairCount; index++) {
    const rubrics = expectedInvocations[index].rubrics;
    if (rubrics?.length) {
      addRubricsToInvocation(actualInvocations[index], rubrics);
    }
  }
}
