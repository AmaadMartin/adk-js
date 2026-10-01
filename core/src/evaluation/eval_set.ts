/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {EvalCaseSchema} from './eval_case.js';

/**
 * A set of eval cases.
 */
export const EvalSetSchema = z
  .object({
    /** Unique identifier for the eval set. */
    evalSetId: z.string(),
    /** Name of the dataset. */
    name: z.string().optional(),
    /** Description of the dataset. */
    description: z.string().optional(),
    /**
     * The eval cases in the dataset. Each case represents a single interaction
     * to be evaluated.
     */
    evalCases: z.array(EvalCaseSchema),
    /** The time at which this eval set was created. */
    creationTimestamp: z.number().default(0),
  })
  .strict();

/**
 * A set of eval cases.
 */
export type EvalSet = z.infer<typeof EvalSetSchema>;
