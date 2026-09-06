/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalMetricResultPerInvocation, EvalStatus} from './eval_metrics.js';

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

  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];
}
