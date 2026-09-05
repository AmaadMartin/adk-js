/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
