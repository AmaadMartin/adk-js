/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// PROVISIONAL: This is a minimal, parity-faithful subset of the evaluation base
// types (ported from adk-python's `eval_metrics.py`). It is provided so this
// port is self-contained and buildable regardless of merge ordering. It is
// superseded by the full evaluation base modules (evaluation sub-ports #1/#2),
// which a later rebase reconciles.

/** The status of a metric evaluation. */
export enum EvalStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

/** A metric used to evaluate a particular aspect of an eval case. */
export interface EvalMetric {
  /** The name of the metric. */
  metricName: string;

  /** A threshold value. Each metric decides how to interpret this threshold. */
  threshold?: number;
}
