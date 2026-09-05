/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The content of a rubric. */
export interface RubricContent {
  /**
   * The property being evaluated. Example: "The agent's response is
   * grammatically correct."
   */
  textProperty?: string;
}

/** A single criterion an evaluator applies to an agent's behaviour. */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The testable criterion. */
  rubricContent: RubricContent;

  /** How to interpret the result of assessing this rubric. */
  description?: string;

  /**
   * A type designator that tells a system how to evaluate the rubric. Use
   * consistent upper snake_case strings, such as `TOOL_USE_QUALITY`,
   * `FINAL_RESPONSE_QUALITY` or `INSTRUCTION_ADHERENCE`.
   */
  type?: string;
}
