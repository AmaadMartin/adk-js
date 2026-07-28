/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {nowSeconds} from '../utils/env_aware_utils.js';
import {toCamelCase} from '../utils/object_notation_utils.js';
import {
  EvalCaseResult,
  EvalSetResult,
  EvalSetResultSchema,
} from './eval_result.js';

/**
 * Keys preserved (not key-rewritten) when serializing an EvalSetResult to disk.
 *
 * These reach opaque sub-objects (session state, tool call args/responses) that
 * may contain data in any notation and must round-trip verbatim.
 *
 * simplicity: ceiling=minimum. The ported fixtures leave `sessionDetails`
 * absent, so these paths are lightly exercised; extend the lists if a
 * round-trip test surfaces a mangled opaque field.
 */
export const EVAL_SET_RESULT_PRESERVE_KEYS_CAMEL_CASE = [
  'evalCaseResults.sessionDetails.state',
  'evalCaseResults.sessionDetails.events.content.parts.functionCall.args',
  'evalCaseResults.sessionDetails.events.content.parts.functionResponse.response',
];

/**
 * The snake_case counterparts of {@link EVAL_SET_RESULT_PRESERVE_KEYS_CAMEL_CASE},
 * used when reading an EvalSetResult from disk.
 */
export const EVAL_SET_RESULT_PRESERVE_KEYS_SNAKE_CASE = [
  'eval_case_results.session_details.state',
  'eval_case_results.session_details.events.content.parts.function_call.args',
  'eval_case_results.session_details.events.content.parts.function_response.response',
];

/**
 * Sanitizes an eval set result name so it is safe to use as a file name.
 */
export function sanitizeEvalSetResultName(evalSetResultName: string): string {
  return evalSetResultName.replaceAll('/', '_');
}

/**
 * Creates a new EvalSetResult from the given eval case results.
 */
export function createEvalSetResult(
  appName: string,
  evalSetId: string,
  evalCaseResults: EvalCaseResult[],
): EvalSetResult {
  const timestamp = nowSeconds();
  const evalSetResultId = `${appName}_${evalSetId}_${timestamp}`;
  const evalSetResultName = sanitizeEvalSetResultName(evalSetResultId);
  return {
    evalSetResultId,
    evalSetResultName,
    evalSetId,
    evalCaseResults,
    creationTimestamp: timestamp,
  };
}

/**
 * Parses an EvalSetResult from JSON.
 *
 * Backward-compatible with legacy eval set result files that were
 * double-encoded, where the outer JSON is a string containing the inner JSON
 * object.
 *
 * @throws {SyntaxError} If the input is not valid JSON.
 * @throws {ZodError} If the decoded value is not a valid EvalSetResult.
 */
export function parseEvalSetResultJson(json: string): EvalSetResult {
  let decoded: unknown = JSON.parse(json);
  if (typeof decoded === 'string') {
    decoded = JSON.parse(decoded);
  }
  return EvalSetResultSchema.parse(
    toCamelCase(decoded, EVAL_SET_RESULT_PRESERVE_KEYS_SNAKE_CASE),
  );
}
