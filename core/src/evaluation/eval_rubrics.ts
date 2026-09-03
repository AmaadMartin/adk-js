/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {evalModel, optionalField, type EvalModel} from './common.js';

/** The content of a rubric. */
export interface RubricContent {
  /**
   * The property being evaluated, e.g. "The agent's response is grammatically
   * correct."
   */
  textProperty?: string;
}

/** A single testable criterion an evaluation applies to a response. */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The actual testable criterion for the rubric. */
  rubricContent: RubricContent;

  /**
   * How the results of this rubric's assessment are to be interpreted.
   */
  description?: string;

  /**
   * A type designator that informs how the rubric is evaluated. Conventionally
   * an upper snake_case string, e.g. `'TOOL_USE_QUALITY'`,
   * `'FINAL_RESPONSE_QUALITY'` or `'INSTRUCTION_ADHERENCE'`.
   */
  type?: string;
}

/** The score obtained after applying a rubric to an agent's response. */
export interface RubricScore {
  /** The id of the rubric that was assessed. */
  rubricId: string;

  /** Reasoning for the score. */
  rationale?: string;

  /** Absent when the assessment did not happen. */
  score?: number;
}

/** Validates a {@link RubricContent} payload. */
export const rubricContentModel: EvalModel<RubricContent> = evalModel(
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
