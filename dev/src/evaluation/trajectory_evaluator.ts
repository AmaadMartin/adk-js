/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isDeepStrictEqual} from 'node:util';
import {ActualToolUse, EvalTurn, ExpectedToolUse} from './eval_types.js';

/** A tool call from either side of the comparison. */
type ToolUse = ExpectedToolUse | ActualToolUse;

/** A tool call reduced to the fields the trajectory is scored on. */
interface NormalizedToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** One scored turn, used by both the failure report and the detail table. */
interface TrajectoryRow {
  /** 1-based position within its conversation. */
  turn: number;
  query: string;
  actual: NormalizedToolUse[];
  expected: NormalizedToolUse[];
  score: number;
}

/** Options for {@link evaluateTrajectory}. */
export interface EvaluateTrajectoryOptions {
  /** Prints a per-turn table of what was expected and what happened. */
  printDetailedResults?: boolean;
}

/**
 * Reduces every entry to the tool name and its arguments, which are the fields
 * the trajectory is scored and reported on. `mock_tool_output` is dropped.
 *
 * A missing `tool_input` becomes `{}`, so eval data that omits the key for a
 * no-argument tool matches a recorded call with empty arguments. adk-python
 * compares `None` against `{}` here and scores the turn 0.
 */
export function normalizeToolUses(toolUses: ToolUse[]): NormalizedToolUse[] {
  return toolUses.map((toolUse) => ({
    tool_name: toolUse.tool_name,
    tool_input: toolUse.tool_input ?? {},
  }));
}

/**
 * Whether two tool-call trajectories match, comparing only the tool name and
 * its arguments in order.
 */
export function areToolsEqual(a: ToolUse[], b: ToolUse[]): boolean {
  return isDeepStrictEqual(normalizeToolUses(a), normalizeToolUses(b));
}

/**
 * Returns the mean tool-use accuracy over the turns of one eval case.
 *
 * A turn scores 1 when its recorded tool calls match the expected ones exactly,
 * and 0 otherwise. The value range is [0, 1] and higher is better.
 */
export function evaluateTrajectory(
  turns: EvalTurn[],
  options: EvaluateTrajectoryOptions = {},
): number {
  const rows = turns.map((turn, index) => scoreTurn(turn, index + 1));

  reportFailures(rows.filter((row) => row.score !== 1));

  if (options.printDetailedResults) {
    printDetailedResults(rows);
  }

  return mean(rows.map((row) => row.score));
}

function scoreTurn(turn: EvalTurn, turnNumber: number): TrajectoryRow {
  const expected = normalizeToolUses(turn.expected_tool_use ?? []);
  const actual = normalizeToolUses(turn.actual_tool_use ?? []);

  return {
    turn: turnNumber,
    query: turn.query,
    actual,
    expected,
    score: areToolsEqual(actual, expected) ? 1 : 0,
  };
}

/** An eval case can hold no turn, so guard the divisor against NaN. */
function mean(scores: number[]): number {
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function reportFailures(failures: TrajectoryRow[]): void {
  if (failures.length === 0) {
    return;
  }

  console.log('Failures:');
  for (const failure of failures) {
    console.log(`{
  "turn": ${failure.turn},
  "query": '${failure.query}',
  "actual": ${JSON.stringify(failure.actual)},
  "expected_tool_use": ${JSON.stringify(failure.expected)},
}
`);
  }
}

/**
 * Prints the per-turn detail as aligned plain text. adk-python renders this
 * with `tabulate`; adding a table dependency for one debug view is not worth
 * the install.
 */
function printDetailedResults(rows: TrajectoryRow[]): void {
  const table = [
    ['query', 'expected_tool_use', 'actual_tool_use', 'score'],
    ...rows.map((row) => [
      row.query,
      JSON.stringify(row.expected),
      JSON.stringify(row.actual),
      String(row.score),
    ]),
  ];

  // Widths come from the content, so a trajectory longer than the header does
  // not push the later columns out of line.
  const widths = table[0].map((_, column) =>
    Math.max(...table.map((cells) => cells[column].length)),
  );

  const [header, ...body] = table.map((cells) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join(' | '),
  );

  console.log(header);
  console.log('-'.repeat(header.length));
  for (const line of body) {
    console.log(line);
  }
}
