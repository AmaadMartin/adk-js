/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {Session} from '../sessions/session.js';
import {evalModel, optionalField, type EvalModel} from './common.js';
import {
  EvalMetric,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from './eval_metrics.js';

/** The evaluation result for one eval case. */
export interface EvalCaseResult {
  /** @deprecated Use {@link evalSetId} instead. */
  evalSetFile?: string;

  evalSetId: string;

  /** The eval case id. */
  evalId: string;

  /**
   * The verdict for the whole eval case. A case whose inference crashed is
   * `FAILED` here while carrying no per-invocation metric results at all.
   */
  finalEvalStatus: EvalStatus;

  /** @deprecated Use {@link overallEvalMetricResults} instead. */
  evalMetricResults?: Array<[EvalMetric, EvalMetricResult]>;

  /**
   * Each metric aggregated over the whole eval case, which is what
   * {@link finalEvalStatus} summarizes. An eval service that reports only
   * per-invocation results leaves it absent; a result file written by
   * adk-python carries it, and `adk eval --print_detailed_results` prints it.
   */
  overallEvalMetricResults?: EvalMetricResult[];

  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[];

  /**
   * The id of the session the inference stage of the eval produced, empty when
   * there was none. adk-python makes the field required and the two SDKs read
   * each other's result files, so an eval service always sets it.
   */
  sessionId: string;

  /** The session itself, when the eval service recorded it. */
  sessionDetails?: Session;

  /** The user id the inference stage ran under. */
  userId?: string;
}

/** The results of evaluating every case in one eval set. */
export interface EvalSetResult {
  evalSetResultId: string;

  /** The name a manager stores the result under. */
  evalSetResultName?: string;

  evalSetId: string;

  evalCaseResults: EvalCaseResult[];

  /** Creation time in seconds since the epoch. */
  creationTimestamp: number;
}

/**
 * A field carrying a value that another evaluation module owns.
 *
 * `Session`, `Invocation` and the metric results have no schema in this
 * package, so the value passes through by reference. That is what
 * adk-python's `arbitrary_types_allowed` does. Every payload this module holds
 * is an object, so the guard rejects a scalar, a `null` and an array without
 * looking at what is inside. A caller that needs the payload itself validated
 * has `parseEvalMetricResult` in `eval_metrics.ts`.
 */
function payloadField<T>(): z.ZodType<T> {
  return z.custom<T>(
    (value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

const EVAL_RESULT_OPTIONS = {extraKeys: 'allow'} as const;

/**
 * Validates an {@link EvalCaseResult} payload.
 *
 * `eval_result.py` builds both models on a plain pydantic `BaseModel`, whose
 * default `extra='ignore'` accepts an unrecognized key. `'allow'` accepts it
 * too, and keeps it.
 */
const evalCaseResultModel: EvalModel<EvalCaseResult> = evalModel(
  {
    evalSetFile: optionalField(z.string()),
    evalSetId: z.string().default(''),
    evalId: z.string().default(''),
    finalEvalStatus: z.enum(EvalStatus),
    evalMetricResults: optionalField(
      z.array(
        z.tuple([payloadField<EvalMetric>(), payloadField<EvalMetricResult>()]),
      ),
    ),
    overallEvalMetricResults: z
      .array(payloadField<EvalMetricResult>())
      .default([]),
    evalMetricResultPerInvocation:
      z.array(payloadField<EvalMetricResultPerInvocation>()),
    sessionId: z.string(),
    sessionDetails: optionalField(payloadField<Session>()),
    userId: optionalField(z.string()),
  },
  {...EVAL_RESULT_OPTIONS, name: 'EvalCaseResult'},
);

/** Validates an {@link EvalSetResult} payload. */
const evalSetResultModel: EvalModel<EvalSetResult> = evalModel(
  {
    evalSetResultId: z.string(),
    evalSetResultName: optionalField(z.string()),
    evalSetId: z.string(),
    evalCaseResults: z.array(evalCaseResultModel.schema).default([]),
    creationTimestamp: z.number().default(0),
  },
  {...EVAL_RESULT_OPTIONS, name: 'EvalSetResult'},
);

/**
 * Validates an eval case result payload and applies adk-python's defaults.
 *
 * pydantic gives `eval_result.py` a validator and a set of field defaults that
 * a TypeScript interface is erased into nothing by. This is that validator:
 * it reads the snake_case keys adk-python writes as well as the camelCase
 * ones, and it defaults `evalSetId` and `evalId` to `''` and
 * `overallEvalMetricResults` to `[]`.
 *
 * The metric, invocation and session payloads pass through by reference and
 * keep the spelling they arrived in. Only the fields this model names are
 * renamed.
 *
 * @throws {InputValidationError} When the payload omits `finalEvalStatus`,
 *   `evalMetricResultPerInvocation` or `sessionId`, or names an eval status
 *   outside {@link EvalStatus}.
 */
export function parseEvalCaseResult(raw: unknown): EvalCaseResult {
  return evalCaseResultModel.parse(raw);
}

/**
 * Validates an eval set result payload and applies adk-python's defaults.
 *
 * Each nested case result is validated as well, so it carries the defaults
 * {@link parseEvalCaseResult} applies. `evalCaseResults` defaults to `[]` and
 * `creationTimestamp` to `0`.
 *
 * @throws {InputValidationError} When the payload omits `evalSetResultId` or
 *   `evalSetId`, or carries a case result that does not validate.
 */
export function parseEvalSetResult(raw: unknown): EvalSetResult {
  return evalSetResultModel.parse(raw);
}
