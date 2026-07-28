/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {Session} from '../sessions/session.js';
import {
  EvalMetricResultPerInvocationSchema,
  EvalMetricResultSchema,
  EvalMetricSchema,
  EvalStatus,
} from './eval_metrics.js';

/**
 * Case-level evaluation results.
 */
export const EvalCaseResultSchema = z
  .object({
    /** @deprecated Use `evalSetId` instead. */
    evalSetFile: z.string().optional(),
    /** The eval set id. */
    evalSetId: z.string().default(''),
    /** The eval case id. */
    evalId: z.string().default(''),
    /** Final eval status for this eval case. */
    finalEvalStatus: z.enum(EvalStatus),
    /** @deprecated Use `overallEvalMetricResults` instead. */
    evalMetricResults: z
      .array(z.tuple([EvalMetricSchema, EvalMetricResultSchema]))
      .optional(),
    /** Overall result for each metric for the entire eval case. */
    overallEvalMetricResults: z.array(EvalMetricResultSchema),
    /** Result for each metric on a per-invocation basis. */
    evalMetricResultPerInvocation: z.array(EvalMetricResultPerInvocationSchema),
    /**
     * Session id of the session generated as a result of the
     * inferencing/scraping stage of the eval.
     */
    sessionId: z.string(),
    /** Session generated as a result of the inferencing/scraping stage. */
    sessionDetails: z.custom<Session>().optional(),
    /** User id used during the inferencing/scraping stage of the eval. */
    userId: z.string().optional(),
  })
  .strict();

/**
 * Case-level evaluation results.
 */
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

/**
 * Eval-set-level evaluation results.
 */
export const EvalSetResultSchema = z
  .object({
    /** Unique identifier for the eval set result. */
    evalSetResultId: z.string(),
    /** Name of the eval set result. */
    evalSetResultName: z.string().optional(),
    /** The eval set id these results belong to. */
    evalSetId: z.string(),
    /** The case-level results contained in this eval set result. */
    evalCaseResults: z.array(EvalCaseResultSchema).default(() => []),
    /** The time at which this eval set result was created. */
    creationTimestamp: z.number().default(0),
  })
  .strict();

/**
 * Eval-set-level evaluation results.
 */
export type EvalSetResult = z.infer<typeof EvalSetResultSchema>;
