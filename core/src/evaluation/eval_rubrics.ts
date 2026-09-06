/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

/** The score obtained by applying a rubric to an agent response. */
export interface RubricScore {
  /** The id of the rubric that was assessed. */
  rubricId: string;

  /** Reasoning for the score. */
  rationale?: string;

  /** The score. Absent when the assessment did not happen. */
  score?: number;
}
