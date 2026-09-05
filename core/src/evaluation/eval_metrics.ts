/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this, so a criterion read
 * from a config file can carry fields this interface does not name.
 */
export interface BaseCriterion {
  threshold: number;
}
