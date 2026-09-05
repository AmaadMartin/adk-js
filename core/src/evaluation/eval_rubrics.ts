/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {evalModel, optionalField, type EvalModel} from './common.js';
// Type-only: `eval_case.ts` imports `Rubric` from here, and erasing both
// directions keeps the two modules out of a runtime import cycle.
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

/** Validates a {@link RubricContent} payload. */
const rubricContentModel: EvalModel<RubricContent> = evalModel(
  {textProperty: optionalField(z.string())},
  {name: 'RubricContent'},
);

/** Validates a {@link Rubric} payload. */
export const rubricModel: EvalModel<Rubric> = evalModel(
  {
    rubricId: z.string(),
    rubricContent: rubricContentModel.schema,
    description: optionalField(z.string()),
    type: optionalField(z.string()),
  },
  {name: 'Rubric'},
);

/** Validates a {@link RubricScore} payload. */
export const rubricScoreModel: EvalModel<RubricScore> = evalModel(
  {
    rubricId: z.string(),
    rationale: optionalField(z.string()),
    score: optionalField(z.number()),
  },
  {name: 'RubricScore'},
);

/**
 * Validates a rubric payload written in either the adk-python spelling
 * (`rubric_id`) or the adk-js one (`rubricId`).
 *
 * @throws {InputValidationError} When the payload is not a valid rubric.
 */
export function parseRubric(raw: unknown): Rubric {
  return rubricModel.parse(raw);
}

/**
 * Validates a rubric score payload.
 *
 * @throws {InputValidationError} When the payload is not a valid rubric score.
 */
export function parseRubricScore(raw: unknown): RubricScore {
  return rubricScoreModel.parse(raw);
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
