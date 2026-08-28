/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isDeepStrictEqual} from 'node:util';
import {
  ActualToolUse,
  EvalTurn,
  ExpectedToolUse,
} from './evaluation_constants.js';

/** A tool call from either side of the comparison. */
type ToolUse = ExpectedToolUse | ActualToolUse;

/** One turn that scored 0, kept for the failure report. */
interface TrajectoryFailure {
  turn: number;
  query: string;
  actual: ActualToolUse[];
  expected: ExpectedToolUse[];
}

/** One scored turn, kept for the detail table. */
interface TrajectoryRow {
  query: string;
  actual: ActualToolUse[];
  expected: ExpectedToolUse[];
  score: number;
}

/** Options for {@link evaluateTrajectory}. */
export interface EvaluateTrajectoryOptions {
  /** Prints a per-turn table of what was expected and what happened. */
  printDetailedResults?: boolean;
}

/**
 * Drops `mock_tool_output` from every entry, leaving the fields the trajectory
 * is scored and reported on.
 */
export function stripMockToolOutputs(
  toolUses: ExpectedToolUse[],
): ExpectedToolUse[] {
  return toolUses.map(({tool_name, tool_input}) => ({tool_name, tool_input}));
}

/**
 * Whether two tool-call trajectories match, comparing only the tool name and
 * its arguments in order.
 *
 * A missing `tool_input` is read as `{}`, so eval data that omits the key for a
 * no-argument tool matches a recorded call with empty arguments. adk-python
 * compares `None` against `{}` here and scores the turn 0.
 */
export function areToolsEqual(a: ToolUse[], b: ToolUse[]): boolean {
  return isDeepStrictEqual(projectForComparison(a), projectForComparison(b));
}

function projectForComparison(
  toolUses: ToolUse[],
): Array<{tool_name: string; tool_input: Record<string, unknown>}> {
  return toolUses.map((toolUse) => ({
    tool_name: toolUse.tool_name,
    tool_input: toolUse.tool_input ?? {},
  }));
}

/**
 * Returns the mean tool-use accuracy over every turn of every conversation.
 *
 * A turn scores 1 when its recorded tool calls match the expected ones exactly,
 * and 0 otherwise. The value range is [0, 1] and higher is better.
 *
 * @param dataset One entry per conversation, each a list of scored turns.
 * @throws Error when the dataset holds no conversation.
 */
export function evaluateTrajectory(
  dataset: EvalTurn[][],
  options: EvaluateTrajectoryOptions = {},
): number {
  if (dataset.length === 0) {
    throw new Error('The evaluation dataset is empty.');
  }

  const rows: TrajectoryRow[] = [];
  const failures: TrajectoryFailure[] = [];

  for (const conversation of dataset) {
    conversation.forEach((turn, index) => {
      const row = scoreTurn(turn);
      rows.push(row);
      if (row.score !== 1) {
        failures.push({
          turn: index + 1,
          query: row.query,
          actual: row.actual,
          expected: row.expected,
        });
      }
    });
  }

  reportFailures(failures);

  if (options.printDetailedResults) {
    printDetailedResults(rows);
  }

  return mean(rows.map((row) => row.score));
}

function scoreTurn(turn: EvalTurn): TrajectoryRow {
  const expected = stripMockToolOutputs(turn.expected_tool_use ?? []);
  const actual = turn.actual_tool_use ?? [];

  return {
    query: turn.query,
    actual,
    expected,
    score: areToolsEqual(actual, expected) ? 1 : 0,
  };
}

/**
 * `dataset` is never empty here, but a conversation in it can be, so guard the
 * divisor rather than returning NaN as a score.
 */
function mean(scores: number[]): number {
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function reportFailures(failures: TrajectoryFailure[]): void {
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
