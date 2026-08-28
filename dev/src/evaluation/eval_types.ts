/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * The eval-data file format and the eval domain model.
 *
 * The zod schemas are the single definition of the on-disk format, and the
 * types are inferred from them, so a field cannot be added to one without the
 * other. Every field stays `snake_case`: these are JSON keys a user writes,
 * and adk-python reads the same files.
 */

/** One recorded tool call, as written in the eval data. */
export const EXPECTED_TOOL_USE_SCHEMA = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  /** When present, the tool is not really called; this value is returned. */
  mock_tool_output: z.unknown().optional(),
});

/** One recorded user turn, before a run fills in what happened. */
export const EVAL_TURN_SCHEMA = z.object({
  query: z.string(),
  expected_tool_use: z.array(EXPECTED_TOOL_USE_SCHEMA).optional(),
  reference: z.string().nullish(),
});

/** The session an eval case starts from. */
export const INITIAL_SESSION_SCHEMA = z.object({
  app_name: z.string().optional(),
  user_id: z.string().optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});

/** One eval case in an eval-set file. */
export const EVAL_SET_ITEM_SCHEMA = z.object({
  name: z.string(),
  data: z.array(EVAL_TURN_SCHEMA),
  initial_session: INITIAL_SESSION_SCHEMA.optional(),
});

/** An eval-set file: a JSON array of cases. */
export const EVAL_SET_FILE_SCHEMA = z.array(EVAL_SET_ITEM_SCHEMA);

/** A criteria file: `{"criteria": {"<metric>": <threshold>}}`. */
export const CRITERIA_FILE_SCHEMA = z.object({
  criteria: z.record(z.string(), z.number().finite()),
});

export type ExpectedToolUse = z.infer<typeof EXPECTED_TOOL_USE_SCHEMA>;
export type InitialSession = z.infer<typeof INITIAL_SESSION_SCHEMA>;

/** One tool call the agent actually made during a run. */
export interface ActualToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * One recorded user turn. `actual_tool_use` and `response` are not part of the
 * file format; the generator writes them onto the turn after the run.
 */
export type EvalTurn = z.infer<typeof EVAL_TURN_SCHEMA> & {
  actual_tool_use?: ActualToolUse[];
  response?: string;
};

export type EvalSetItem = Omit<z.infer<typeof EVAL_SET_ITEM_SCHEMA>, 'data'> & {
  data: EvalTurn[];
};

/** A hook an agent file exports to clear its own state before a case runs. */
export type ResetFunc = () => void | Promise<void>;

/**
 * The verdict for one metric, or for a whole eval case.
 *
 * The values are the words adk-python prints, so a console transcript reads
 * the same in both SDKs.
 */
export enum EvalStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

/** One metric the run scores, and the score it has to reach to pass. */
export interface EvalMetric {
  metricName: string;
  threshold: number;
}

/** What one metric scored on one eval case. */
export interface EvalMetricResult {
  /** Absent when the metric was not evaluated. */
  score?: number;
  evalStatus: EvalStatus;
}

/** The outcome of one eval case. */
export interface EvalResult {
  evalSetFile: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  evalMetricResults: Array<[EvalMetric, EvalMetricResult]>;
  sessionId: string;
}

/** Scores the tool calls a run made against the recorded ones. */
export const TOOL_TRAJECTORY_SCORE_KEY = 'tool_trajectory_avg_score';

/** Scores a run's final response against the turn's `reference`. */
export const RESPONSE_MATCH_SCORE_KEY = 'response_match_score';

/** Prefix of every session an eval case runs in. */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/** The criteria used when no config file is supplied. */
export const DEFAULT_CRITERIA: Readonly<Record<string, number>> = {
  [TOOL_TRAJECTORY_SCORE_KEY]: 1.0,
  [RESPONSE_MATCH_SCORE_KEY]: 0.8,
};

/** The app name a case without an `initial_session.app_name` runs under. */
export const DEFAULT_EVAL_APP_NAME = 'EvaluationGenerator';

/** The user id a case without an `initial_session.user_id` runs under. */
export const DEFAULT_EVAL_USER_ID = 'test_user_id';
