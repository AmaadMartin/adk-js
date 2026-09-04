/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RubricScore} from './eval_rubrics.js';

/** A score an auto-rater produced for one sample of one invocation. */
export interface AutoRaterScore {
  /** The overall score. Absent when it could not be determined. */
  score?: number;

  /** Per-rubric scores, when the auto-rater is rubric based. */
  rubricScores?: RubricScore[];
}
