/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

export interface Interval {
  minValue: number;
  openAtMin: boolean;
  maxValue: number;
  openAtMax: boolean;
}

export interface MetricValueInfo {
  interval?: Interval;
}

export interface MetricInfo {
  metricName: string;
  description?: string;
  metricValueInfo: MetricValueInfo;
}

export interface RubricScore {
  rubricName: string;
  score: number;
  explanation?: string;
}

export interface EvalMetricResultDetails {
  rubricScores?: RubricScore[];
}

export interface EvalMetricResult {
  metricName: string;
  score?: number;
  evalStatus: EvalStatus;
  details?: EvalMetricResultDetails;
}

export interface Invocation {
  [key: string]: unknown;
}

export interface EvalMetricResultPerInvocation {
  actualInvocation: Invocation;
  expectedInvocation?: Invocation;
  evalMetricResults: EvalMetricResult[];
}

export interface EvalCaseResult {
  evalSetId: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  overallEvalMetricResults: EvalMetricResult[];
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];
  sessionId: string;
  userId?: string;
}

export interface EvalSetResult {
  evalSetResultId: string;
  evalSetResultName?: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
  creationTimestamp: number;
}
