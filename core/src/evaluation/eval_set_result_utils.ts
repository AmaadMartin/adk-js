/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JSON boundary of an {@link EvalSetResult}.
 *
 * Result files are written by adk-python as well as by this package, so the
 * field names on disk are snake_case and the identifiers are built the way
 * adk-python builds them.
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {isRecord, toCamelKeys, toSnakeKeys} from './eval_json.js';
import {EvalCaseResult} from './eval_result.js';
import {EvalSetResult} from './eval_set_results_manager.js';

/** Milliseconds per second, for the epoch-seconds timestamps eval data uses. */
const MILLIS_PER_SECOND = 1000;

/**
 * A freshly created eval set result. Its name is what a manager stores it
 * under, so unlike a result read back from storage it always carries one.
 */
export type NamedEvalSetResult = EvalSetResult & {evalSetResultName: string};

/** Builds the result of one eval run, with the identifiers adk-python uses. */
export function createEvalSetResult(
  appName: string,
  evalSetId: string,
  evalCaseResults: EvalCaseResult[],
): NamedEvalSetResult {
  const timestamp = Date.now() / MILLIS_PER_SECOND;
  const evalSetResultId = `${appName}_${evalSetId}_${timestamp}`;
  return {
    evalSetResultId,
    // The name becomes a file name, and a `/` in the app name would otherwise
    // make it a directory separator.
    evalSetResultName: evalSetResultId.replace(/\//g, '_'),
    evalSetId,
    evalCaseResults,
    creationTimestamp: timestamp,
  };
}

/** Serializes an eval set result to its on-disk JSON form. */
export function serializeEvalSetResult(evalSetResult: EvalSetResult): string {
  return JSON.stringify(toSnakeKeys(evalSetResult), undefined, 2);
}

/**
 * Parses an eval set result written by either SDK.
 *
 * Older files are double-encoded: the outer JSON is a string that holds the
 * JSON object, so a first parse yields a string rather than the result.
 *
 * @throws {InputValidationError} When the JSON is not an eval set result.
 */
export function parseEvalSetResultJson(raw: string): EvalSetResult {
  const decoded: unknown = JSON.parse(raw);
  const converted = toCamelKeys(
    typeof decoded === 'string' ? JSON.parse(decoded) : decoded,
  );
  if (!isRecord(converted)) {
    throw new InputValidationError('An eval set result must be a JSON object.');
  }
  const evalSetResultId = converted['evalSetResultId'];
  const evalSetId = converted['evalSetId'];
  const evalCaseResults = converted['evalCaseResults'];
  if (typeof evalSetResultId !== 'string' || typeof evalSetId !== 'string') {
    throw new InputValidationError(
      'An eval set result must have an `eval_set_result_id` and an ' +
        '`eval_set_id`.',
    );
  }
  if (!Array.isArray(evalCaseResults)) {
    throw new InputValidationError(
      'An eval set result must have `eval_case_results`.',
    );
  }
  const evalSetResultName = converted['evalSetResultName'];
  const creationTimestamp = converted['creationTimestamp'];
  return {
    evalSetResultId,
    evalSetResultName:
      typeof evalSetResultName === 'string' ? evalSetResultName : undefined,
    evalSetId,
    // The case results are the payload of the file rather than fields this
    // module reads, so they are carried across as written.
    evalCaseResults: evalCaseResults as EvalCaseResult[],
    creationTimestamp:
      typeof creationTimestamp === 'number' ? creationTimestamp : 0,
  };
}
