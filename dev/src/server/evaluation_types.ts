/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

export interface Invocation {
  invocationId: string;
  userContent: Content;
  finalResponse?: Content;
  intermediateData?: Record<string, unknown>; // To store tool calls and responses, if any.
  creationTimestamp: number;
}

export interface SessionInput {
  appName: string;
  userId: string;
  state: Record<string, unknown>;
}

export interface EvalCase {
  evalId: string;
  conversation?: Invocation[];
  sessionInput?: SessionInput;
  creationTimestamp: number;
}

export interface EvalSet {
  evalSetId: string;
  name: string;
  creationTimestamp: number;
  evalCases: EvalCase[];
  description?: string;
}

export interface EvalMetricResultPerInvocation {
  actualInvocation: Invocation;
  expectedInvocation?: Invocation;
  evalMetricResults: unknown[];
}

export interface EvalCaseResult {
  evalSetFile: string;
  evalSetId: string;
  evalId: string;
  finalEvalStatus: 'PASSED' | 'FAILED' | 'NOT_EVALUATED';
  overallEvalMetricResults: unknown[];
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];
  sessionId: string;
  sessionDetails?: Record<string, unknown>;
  userId: string;
}

export interface EvalSetResult {
  evalSetResultId: string;
  evalSetResultName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
  creationTimestamp: number;
}
