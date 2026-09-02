/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval data model.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export {getAllToolCalls, isInvocationEvents} from './eval_case.js';
export type {
  EvalCase,
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  SessionInput,
} from './eval_case.js';
export type {EvalSet} from './eval_set.js';
