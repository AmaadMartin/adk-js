/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A tool call recorded in an eval dataset: either one the agent is expected to
 * make, or one it actually made.
 *
 * The property names are the keys of adk-python's `*.test.json` files, so a
 * dataset written by either SDK loads in the other.
 */
export interface ToolUse {
  /**
   * The tool's name. Optional because `FunctionCall.name` is optional in
   * `@google/genai`, so a recorded call may genuinely have none.
   */
  tool_name?: string;
  /** The arguments the tool was, or is expected to be, called with. */
  tool_input?: Record<string, unknown>;
  /**
   * When present, the generator answers this tool call from the recording
   * instead of executing the tool. Presence is what counts, not truthiness.
   */
  mock_tool_output?: unknown;
}

/** One recorded turn of an eval conversation. */
export interface EvalEntry {
  /** The user's message for this turn. */
  query: string;
  /** The tool calls the agent is expected to make. */
  expected_tool_use?: ToolUse[];
  /** The reference answer, used by response scoring. Carried through as-is. */
  reference?: string;
  /** Filled in by the generator: the tool calls the agent actually made. */
  actual_tool_use?: ToolUse[];
  /** Filled in by the generator: the agent's final response text. */
  response?: string;
}

/** An ordered sequence of turns replayed as one session. */
export type EvalConversation = EvalEntry[];
