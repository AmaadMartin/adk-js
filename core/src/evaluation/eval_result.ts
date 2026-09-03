/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';
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

  /**
   * The inference session this result was produced in, empty when there was
   * none. adk-python makes the field required and the two SDKs read each
   * other's result files, so an eval service always sets it.
   */
  sessionId?: string;

  /** The session as it stood after inference, when the service could load it. */
  sessionDetails?: Session;

  /** The user id inference ran under. */
  userId?: string;
}
