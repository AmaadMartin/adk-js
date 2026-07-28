/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * The content of a rubric.
 *
 * Rejects unknown keys (parity with adk-python `EvalBaseModel`'s
 * `extra="forbid"`).
 */
export const RubricContentSchema = z
  .object({
    /**
     * The property being evaluated. Example: "The agent's response is
     * grammatically correct."
     */
    textProperty: z.string().optional(),
  })
  .strict();

/**
 * The content of a rubric.
 */
export type RubricContent = z.infer<typeof RubricContentSchema>;

/**
 * A single rubric: a testable criterion used to assess an agent's response.
 */
export const RubricSchema = z
  .object({
    /** Unique identifier for the rubric. */
    rubricId: z.string(),
    /** The actual testable criterion for the rubric. */
    rubricContent: RubricContentSchema,
    /**
     * A description of the rubric that provides details on how the results of
     * the rubric assessment should be interpreted.
     */
    description: z.string().optional(),
    /**
     * Optional type designator for the rubric, which can inform how it's
     * evaluated or interpreted. Recommended to use consistent, well-defined,
     * upper snake_case strings (e.g. "TOOL_USE_QUALITY").
     */
    type: z.string().optional(),
  })
  .strict();

/**
 * A single rubric: a testable criterion used to assess an agent's response.
 */
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * The score obtained after applying a rubric to the agent's response.
 */
export const RubricScoreSchema = z
  .object({
    /** The id of the rubric that was assessed. */
    rubricId: z.string(),
    /** Reasoning/rationale for the score. */
    rationale: z.string().optional(),
    /**
     * Score obtained after assessing the rubric. Optional, as assessment might
     * not have happened.
     */
    score: z.number().optional(),
  })
  .strict();

/**
 * The score obtained after applying a rubric to the agent's response.
 */
export type RubricScore = z.infer<typeof RubricScoreSchema>;
