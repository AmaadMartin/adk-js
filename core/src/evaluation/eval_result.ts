/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';
import {
  EvalMetric,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from './eval_metrics.js';

/**
 * Case-level evaluation results.
 */
export interface EvalCaseResult {
  /**
   * @deprecated Use `evalSetId` instead.
   */
  evalSetFile?: string;

  /** The eval set id. Defaults to an empty string. */
  evalSetId?: string;

  /** The eval case id. Defaults to an empty string. */
  evalId?: string;

  /** Final eval status for this eval case. */
  finalEvalStatus: EvalStatus;

  /**
   * @deprecated Use `overallEvalMetricResults` instead.
   */
  evalMetricResults?: Array<[EvalMetric, EvalMetricResult]>;

  /** The overall result of each metric for the whole eval case. */
  overallEvalMetricResults: EvalMetricResult[];

  /** The result of each metric for each invocation. */
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];

  /** Id of the session that the inference phase generated. */
  sessionId: string;

  /** The session that the inference phase generated. */
  sessionDetails?: Session;

  /** The user id that the inference phase used. */
  userId?: string;
}
