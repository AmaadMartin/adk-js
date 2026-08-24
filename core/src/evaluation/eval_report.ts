/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {getAllToolCalls, IntermediateDataType} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {PerInvocationResult} from './evaluator.js';

/** Fields rendered for each invocation, in order. */
const DETAIL_FIELDS = [
  'eval_status',
  'score',
  'threshold',
  'prompt',
  'expected_response',
  'actual_response',
  'expected_tool_calls',
  'actual_tool_calls',
] as const;

const LABEL_WIDTH = Math.max(...DETAIL_FIELDS.map((field) => field.length));

/** Joins the text of every part of `content` that carries text. */
export function convertContentToText(content?: Content): string {
  return (content?.parts ?? [])
    .filter((part) => part.text)
    .map((part) => part.text)
    .join('\n');
}

/** Renders the tool calls held by `intermediateData`, one per line. */
export function convertToolCallsToText(
  intermediateData?: IntermediateDataType,
): string {
  return getAllToolCalls(intermediateData)
    .map((toolCall) => JSON.stringify(toolCall))
    .join('\n');
}

function formatScore(score?: number): string {
  return score === undefined ? 'none' : String(score);
}

function formatField(label: string, value: string): string {
  const indent = ' '.repeat(LABEL_WIDTH + 6);
  const wrapped = value.split('\n').join(`\n${indent}`);
  return `    ${label.padEnd(LABEL_WIDTH)}: ${wrapped}`;
}

function formatInvocation(
  result: PerInvocationResult,
  threshold: number,
  index: number,
): string {
  const expected = result.expectedInvocation;
  const values: Record<(typeof DETAIL_FIELDS)[number], string> = {
    eval_status: EvalStatus[result.evalStatus],
    score: formatScore(result.score),
    threshold: String(threshold),
    prompt: convertContentToText(
      expected ? expected.userContent : result.actualInvocation.userContent,
    ),
    expected_response: convertContentToText(expected?.finalResponse),
    actual_response: convertContentToText(
      result.actualInvocation.finalResponse,
    ),
    expected_tool_calls: convertToolCallsToText(expected?.intermediateData),
    actual_tool_calls: convertToolCallsToText(
      result.actualInvocation.intermediateData,
    ),
  };

  const lines = DETAIL_FIELDS.map((field) => formatField(field, values[field]));
  return [`  [${index}]`, ...lines].join('\n');
}

/**
 * Renders the per-invocation detail for one metric as plain aligned text.
 *
 * @param metricName The metric the results belong to.
 * @param threshold The threshold the metric was compared against.
 * @param overallScore The mean score across all runs, if any score was produced.
 * @param overallEvalStatus The verdict derived from `overallScore`.
 * @param results Every per-invocation result recorded for the metric.
 */
export function formatMetricDetails(
  metricName: string,
  threshold: number,
  overallScore: number | undefined,
  overallEvalStatus: EvalStatus,
  results: PerInvocationResult[],
): string {
  const summary =
    `Summary: \`${EvalStatus[overallEvalStatus]}\` for Metric:` +
    ` \`${metricName}\`. Expected threshold: \`${threshold}\`, actual value:` +
    ` \`${formatScore(overallScore)}\`.`;
  const invocations = results.map((result, index) =>
    formatInvocation(result, threshold, index + 1),
  );
  return [summary, ...invocations].join('\n');
}
