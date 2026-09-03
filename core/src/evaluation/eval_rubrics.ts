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

/** A single rubric. */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The actual testable criterion for the rubric. */
  rubricContent: RubricContent;

  /**
   * How the results of the rubric assessment should be interpreted.
   */
  description?: string;

  /**
   * A type designator, which can inform how the rubric is evaluated. Use
   * consistent upper snake_case strings, e.g. `'TOOL_USE_QUALITY'`.
   */
  type?: string;
}

/** The score obtained after applying a rubric to the agent's response. */
export interface RubricScore {
  /** The id of the rubric that was assessed. */
  rubricId: string;

  /** Reasoning for the score. */
  rationale?: string;

  /** Absent when the rubric was not assessed. */
  score?: number;
}
