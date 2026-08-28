/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The eval-data file format.
 *
 * Every field stays `snake_case` because these are JSON keys a user writes,
 * and the same files are read by adk-python.
 */

/** One recorded tool call, as written in the eval data. */
export interface ExpectedToolUse {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  /** When present, the tool is not really called; this value is returned. */
  mock_tool_output?: unknown;
}

/** One tool call the agent actually made during a run. */
export interface ActualToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** One recorded user turn of an eval case. */
export interface EvalTurn {
  query: string;
  expected_tool_use?: ExpectedToolUse[];
  reference?: string | null;
  /** Filled in by the generator. */
  actual_tool_use?: ActualToolUse[];
  /** Filled in by the generator. */
  response?: string;
}

/** The session the eval case starts from. */
export interface InitialSession {
  app_name?: string;
  user_id?: string;
  state?: Record<string, unknown>;
}

/** One eval case in an eval-set file. */
export interface EvalSetItem {
  name: string;
  data: EvalTurn[];
  initial_session?: InitialSession;
}
