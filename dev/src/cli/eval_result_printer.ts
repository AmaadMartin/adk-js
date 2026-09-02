/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The console output of `adk eval`.
 *
 * The lines match adk-python's, because a script that greps an eval run's
 * output should not have to know which SDK produced it. adk-python renders
 * the per-invocation detail with `pandas` and `tabulate`; this uses the grid
 * renderer already in `@google/adk`, which `AgentEvaluator` prints its own
 * detail with.
 */

import {
  EvalCaseResult,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
  getAllToolCalls,
  Invocation,
  renderGridTable,
} from '@google/adk';
import {Content} from '@google/genai';

const SUMMARY_RULE = '*'.repeat(69);
const DETAIL_RULE = '*'.repeat(68);
const METRIC_RULE = '-'.repeat(69);

/** The widest a cell of the invocation table may be before it wraps. */
const MAX_DETAIL_COLUMN_WIDTH = 25;

/** The invocation columns, before the per-metric ones. */
const INVOCATION_COLUMNS: readonly string[] = [
  'prompt',
  'expected_response',
  'actual_response',
  'expected_tool_calls',
  'actual_tool_calls',
];

/** One row of the invocation table. A column an invocation lacks is absent. */
type InvocationRow = Record<string, string | undefined>;

/** Joins the text parts of a content, as adk-python's eval output does. */
function contentToText(content?: Content): string {
  return (content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined)
    .join('\n');
}

/** Renders the tool calls of an invocation, one per line. */
function toolCallsToText(invocation: Invocation): string {
  return getAllToolCalls(invocation.intermediateData)
    .map((toolCall) => JSON.stringify(toolCall))
    .join('\n');
}

/** Renders the verdict of one metric, as it appears in a table cell. */
function metricCell(metricResult: EvalMetricResult): string {
  return (
    `Status: ${EvalStatus[metricResult.evalStatus]}, ` +
    `Score: ${metricResult.score}`
  );
}

function toInvocationRow(
  perInvocation: EvalMetricResultPerInvocation,
): InvocationRow {
  const {actualInvocation, expectedInvocation} = perInvocation;
  const row: InvocationRow = {
    'prompt': contentToText(actualInvocation.userContent),
    'expected_response':
      expectedInvocation && contentToText(expectedInvocation.finalResponse),
    'actual_response': contentToText(actualInvocation.finalResponse),
    'expected_tool_calls':
      expectedInvocation && toolCallsToText(expectedInvocation),
    'actual_tool_calls': toolCallsToText(actualInvocation),
  };
  for (const metricResult of perInvocation.evalMetricResults) {
    row[metricResult.metricName] = metricCell(metricResult);
  }
  return row;
}

/**
 * Returns the columns to render: the invocation columns that at least one row
 * has a value for, then every metric that was scored.
 */
function columnsToKeep(rows: readonly InvocationRow[]): string[] {
  const metricColumns = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!INVOCATION_COLUMNS.includes(column)) {
        metricColumns.add(column);
      }
    }
  }
  const kept = INVOCATION_COLUMNS.filter((column) =>
    rows.some((row) => row[column] !== undefined),
  );
  return [...kept, ...metricColumns];
}

/** Prints the pass and fail counts of a run, one line per eval set. */
export function printEvalRunSummary(results: readonly EvalCaseResult[]): void {
  const passedByEvalSet = new Map<string, {passed: number; failed: number}>();
  for (const result of results) {
    let counts = passedByEvalSet.get(result.evalSetId);
    if (!counts) {
      counts = {passed: 0, failed: 0};
      passedByEvalSet.set(result.evalSetId, counts);
    }
    if (result.finalEvalStatus === EvalStatus.PASSED) {
      counts.passed++;
    } else {
      counts.failed++;
    }
  }

  console.log(SUMMARY_RULE);
  console.log('Eval Run Summary');
  for (const [evalSetId, counts] of passedByEvalSet) {
    console.log(
      `${evalSetId}:\n  Tests passed: ${counts.passed}\n  Tests failed: ` +
        `${counts.failed}`,
    );
  }
}

/** Prints the metric verdicts and the invocations behind one eval case. */
export function printDetailedEvalResult(result: EvalCaseResult): void {
  console.log(DETAIL_RULE);
  console.log(`Eval Set Id: ${result.evalSetId}`);
  console.log(`Eval Id: ${result.evalId}`);
  console.log(`Overall Eval Status: ${EvalStatus[result.finalEvalStatus]}`);

  for (const metricResult of result.overallEvalMetricResults ?? []) {
    console.log(METRIC_RULE);
    console.log(
      `Metric: ${metricResult.metricName}, ` +
        `Status: ${EvalStatus[metricResult.evalStatus]}, ` +
        `Score: ${metricResult.score}, ` +
        `Threshold: ${metricResult.criterion?.threshold ?? metricResult.threshold}`,
    );
  }

  const rows = result.evalMetricResultPerInvocation.map(toInvocationRow);
  if (rows.length === 0) {
    return;
  }
  console.log(METRIC_RULE);
  console.log('Invocation Details:');
  console.log(
    renderGridTable(rows, columnsToKeep(rows), MAX_DETAIL_COLUMN_WIDTH),
  );
}
