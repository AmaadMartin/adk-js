/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
// Type-only: `eval_case.ts` imports `Rubric` from here, and erasing both
// directions keeps the two modules out of a runtime import cycle.
import type {EvalCase, Invocation} from './eval_case.js';

/** The content of a rubric. */
export interface RubricContent {
  /**
   * The property being evaluated, e.g. "The agent's response is
   * grammatically correct."
   */
  textProperty?: string;
}

/** A single testable criterion an agent response is judged against. */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The actual testable criterion. */
  rubricContent: RubricContent;

  /** How the result of assessing this rubric should be interpreted. */
  description?: string;

  /**
   * A type designator that informs how the rubric is evaluated or displayed.
   * Conventionally an upper snake_case string, e.g. `TOOL_USE_QUALITY`,
   * `FINAL_RESPONSE_QUALITY`, `INSTRUCTION_ADHERENCE`.
   */
  type?: string;
}

/**
 * Appends `rubricsToAdd` to the invocation's own rubrics.
 *
 * @throws {InputValidationError} If a rubric id is already on the invocation,
 *   or appears twice in `rubricsToAdd`.
 */
export function addRubricsToInvocation(
  invocation: Invocation,
  rubricsToAdd: Rubric[],
): void {
  const rubrics = (invocation.rubrics ??= []);
  const existingIds = new Set(rubrics.map((rubric) => rubric.rubricId));
  for (const rubric of rubricsToAdd) {
    if (existingIds.has(rubric.rubricId)) {
      throw new InputValidationError(
        `Rubric with rubric_id '${rubric.rubricId}' already exists.`,
      );
    }
    rubrics.push(rubric);
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

/** Copies each expected invocation's rubrics onto its actual counterpart. */
export function copyInvocationRubricsToActualInvocations(
  expectedInvocations: Invocation[] | undefined,
  actualInvocations: Invocation[],
): void {
  if (!expectedInvocations) {
    return;
  }
  const paired = Math.min(expectedInvocations.length, actualInvocations.length);
  for (let index = 0; index < paired; index++) {
    const rubrics = expectedInvocations[index].rubrics;
    if (rubrics?.length) {
      addRubricsToInvocation(actualInvocations[index], rubrics);
    }
  }
}
