/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {evalModel, optionalField, type EvalModel} from './common.js';

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
