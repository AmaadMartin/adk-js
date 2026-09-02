/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from './eval_metrics.js';

/** The evaluation result for one eval case. */
export interface EvalCaseResult {
  evalSetId: string;

  /** The eval case id. */
  evalId: string;

  /**
   * The verdict for the whole eval case. A case whose inference crashed is
   * `FAILED` here while carrying no per-invocation metric results at all.
   */
  finalEvalStatus: EvalStatus;

  /**
   * Each metric aggregated over the whole eval case, which is what
   * {@link finalEvalStatus} summarizes. An eval service that reports only
   * per-invocation results leaves it absent; a result file written by
   * adk-python carries it, and `adk eval --print_detailed_results` prints it.
   */
  overallEvalMetricResults?: EvalMetricResult[];

  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];
}
