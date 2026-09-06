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
import {toCamelCase, toSnakeCase} from '../utils/object_notation_utils.js';
import {EvalStatus} from './eval_metrics.js';
import {EvalCaseResult, EvalSetResult} from './eval_result.js';

/** Milliseconds per second, for the epoch-seconds timestamps eval data uses. */
const MILLIS_PER_SECOND = 1000;

/**
 * Keys whose values are opaque user data, wherever they occur in the document.
 *
 * A result carries a whole `Session`, which holds maps keyed by user data:
 * session state keys, artifact file names, an opaque agent state snapshot, a
 * node's structured output and the model's custom metadata. Renaming those
 * keys corrupts them. `PRESERVE_KEYS_CAMEL_CASE` in `events/event.ts` is the
 * same set for the event converter; `route` needs no entry, because its value
 * is a string or an array of strings.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'args',
  'response',
  'state',
  'final_session_state',
  'finalSessionState',
  'state_delta',
  'stateDelta',
  'artifact_delta',
  'artifactDelta',
  'agent_state',
  'agentState',
  'custom_metadata',
  'customMetadata',
  'output',
]);

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
  return JSON.stringify(
    toSnakeCase(evalSetResult, [], OPAQUE_KEYS),
    undefined,
    2,
  );
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
  const converted = toCamelCase(
    typeof decoded === 'string' ? JSON.parse(decoded) : decoded,
    [],
    OPAQUE_KEYS,
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
  if (!evalCaseResults.every(isEvalCaseResult)) {
    throw new InputValidationError(
      'Every eval case result must have an `eval_set_id`, an `eval_id`, a ' +
        '`session_id`, a `final_eval_status` and ' +
        '`eval_metric_result_per_invocation`.',
    );
  }
  const evalSetResultName = converted['evalSetResultName'];
  const creationTimestamp = converted['creationTimestamp'];
  return {
    evalSetResultId,
    evalSetResultName:
      typeof evalSetResultName === 'string' ? evalSetResultName : undefined,
    evalSetId,
    evalCaseResults,
    creationTimestamp:
      typeof creationTimestamp === 'number' ? creationTimestamp : 0,
  };
}

/** Narrows an unknown value to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EVAL_STATUSES: ReadonlySet<unknown> = new Set([
  EvalStatus.PASSED,
  EvalStatus.FAILED,
  EvalStatus.NOT_EVALUATED,
]);

/**
 * Returns whether a value carries every field an {@link EvalCaseResult}
 * requires. The optional fields hold metric and session payloads that this
 * module never reads, so they are left to the writer.
 */
function isEvalCaseResult(value: unknown): value is EvalCaseResult {
  return (
    isRecord(value) &&
    typeof value['evalSetId'] === 'string' &&
    typeof value['evalId'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    EVAL_STATUSES.has(value['finalEvalStatus']) &&
    Array.isArray(value['evalMetricResultPerInvocation'])
  );
}
