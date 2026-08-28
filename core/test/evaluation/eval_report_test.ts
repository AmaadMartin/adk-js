/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {Invocation} from '../../src/evaluation/eval_case.js';
import {EvalStatus} from '../../src/evaluation/eval_metrics.js';
import {formatMetricDetails} from '../../src/evaluation/eval_report.js';
import {PerInvocationResult} from '../../src/evaluation/evaluator.js';

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    invocationId: 'inv-1',
    userContent: {role: 'user', parts: [{text: 'Roll a die'}]},
    creationTimestamp: 0,
    ...overrides,
  };
}

/** Renders one result, fixing the metric fields these tests do not vary. */
function renderOne(result: PerInvocationResult): string {
  return formatMetricDetails('m', 0.8, 0.25, EvalStatus.FAILED, [result]);
}

describe('formatMetricDetails content rendering', () => {
  it('renders an empty value for missing content', () => {
    const details = renderOne({
      actualInvocation: invocation(),
      evalStatus: EvalStatus.FAILED,
    });

    expect(details).toContain('expected_response  : \n');
  });

  it('renders an empty value for content with no parts', () => {
    const details = renderOne({
      actualInvocation: invocation(),
      expectedInvocation: invocation({finalResponse: {role: 'model'}}),
      evalStatus: EvalStatus.FAILED,
    });

    expect(details).toContain('expected_response  : \n');
  });

  it('joins the text parts and skips the others', () => {
    const details = renderOne({
      actualInvocation: invocation({
        finalResponse: {
          role: 'model',
          parts: [{text: 'one'}, {functionCall: {name: 'f'}}, {text: 'two'}],
        },
      }),
      evalStatus: EvalStatus.FAILED,
    });

    const indent = ' '.repeat('    actual_response    : '.length);
    expect(details).toContain(`actual_response    : one\n${indent}two`);
  });

  it('renders an empty value for missing intermediate data', () => {
    const details = renderOne({
      actualInvocation: invocation(),
      evalStatus: EvalStatus.FAILED,
    });

    expect(details).toContain('expected_tool_calls: \n');
  });

  it('renders the tool calls held directly', () => {
    const details = renderOne({
      actualInvocation: invocation({
        intermediateData: {
          toolUses: [{name: 'roll_die', args: {sides: 17}}],
          toolResponses: [],
          intermediateResponses: [],
        },
      }),
      evalStatus: EvalStatus.FAILED,
    });

    expect(details).toContain(
      'actual_tool_calls  : {"name":"roll_die","args":{"sides":17}}',
    );
  });

  it('renders the tool calls carried by invocation events', () => {
    const details = renderOne({
      actualInvocation: invocation({
        intermediateData: {
          invocationEvents: [
            {
              author: 'dice_agent',
              content: {parts: [{functionCall: {name: 'roll_die'}}]},
            },
          ],
        },
      }),
      evalStatus: EvalStatus.FAILED,
    });

    expect(details).toContain('actual_tool_calls  : {"name":"roll_die"}');
  });
});

describe('formatMetricDetails', () => {
  const passing: PerInvocationResult = {
    actualInvocation: invocation({
      finalResponse: {role: 'model', parts: [{text: 'first\nsecond'}]},
      intermediateData: {
        toolUses: [{name: 'roll_die', args: {sides: 17}}],
        toolResponses: [],
        intermediateResponses: [],
      },
    }),
    expectedInvocation: invocation({
      finalResponse: {role: 'model', parts: [{text: 'expected answer'}]},
    }),
    score: 0.25,
    evalStatus: EvalStatus.FAILED,
  };

  it('renders the summary line and one block per invocation', () => {
    const details = formatMetricDetails(
      'response_match_score',
      0.8,
      0.25,
      EvalStatus.FAILED,
      [passing],
    );

    expect(details).toContain(
      'Summary: `FAILED` for Metric: `response_match_score`.' +
        ' Expected threshold: `0.8`, actual value: `0.25`.',
    );
    expect(details).toContain('  [1]');
    expect(details).toContain('eval_status        : FAILED');
    expect(details).toContain('expected_response  : expected answer');
    expect(details).toContain('actual_tool_calls  : {"name":"roll_die"');
  });

  it('indents the continuation lines of a multi-line value', () => {
    const details = formatMetricDetails(
      'response_match_score',
      0.8,
      0.25,
      EvalStatus.FAILED,
      [passing],
    );

    const indent = ' '.repeat('    actual_response    : '.length);
    expect(details).toContain(`actual_response    : first\n${indent}second`);
  });

  it('falls back to the actual prompt when there is no expectation', () => {
    const details = formatMetricDetails(
      'unscored_metric',
      0.5,
      undefined,
      EvalStatus.NOT_EVALUATED,
      [
        {
          actualInvocation: invocation(),
          evalStatus: EvalStatus.NOT_EVALUATED,
        },
      ],
    );

    expect(details).toContain('actual value: `none`');
    expect(details).toContain('score              : none');
    expect(details).toContain('prompt             : Roll a die');
    expect(details).toContain('expected_response  : \n');
  });
});
